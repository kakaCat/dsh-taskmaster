// 绑定台账（FR-14）：(graphId, graphVersion, taskId, runId) 四元组唯一 + sessionId 寻址。
// 薄模块：存储复用 persister（bindings.json 走原子写）；本模块的价值是不变量强制——
//   ① 任务同时刻 ≤1 条活跃绑定（CAS 占位的台账侧）
//   ② 同一 sessionId 不出现在两条活跃绑定（一窗口一单活）
//   ③ 世代：新绑定签发新 runId，旧世代回话 stale-run 拒收
// 历史不在这里：终态关绑定，永久留痕在 events/ 与 runs/。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { atomicWriteFileSync } from "../persister/atomic-write.js";

export class BindingConflictError extends Error {
  constructor(reason, detail) {
    super(`binding conflict: ${reason} (${detail})`);
    this.code = "binding-conflict";
  }
}

export class StaleRunError extends Error {
  constructor(taskId, runId) {
    super(`stale run: task ${taskId} rejected runId ${runId}`);
    this.code = "stale-run";
  }
}

export class Binder {
  /** @param dataRoot 数据根 */
  constructor(dataRoot) {
    this.path = join(dataRoot, "bindings.json");
    this.bindings = this.#load();
  }

  #load() {
    if (!existsSync(this.path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // 台账损坏：从空台账起步，由 Boot 按事件流重放重建（#11）；
      // 建不全的在途任务按纪律标 stalled 报人。
      return [];
    }
  }

  #persist() {
    atomicWriteFileSync(this.path, JSON.stringify(this.bindings, null, 2));
  }

  active() {
    return this.bindings.filter((b) => b.state === "active");
  }

  byTask(taskId) {
    return this.active().find((b) => b.taskId === taskId) ?? null;
  }

  bySession(sessionId) {
    return this.active().find((b) => b.sessionId === sessionId) ?? null;
  }

  byGraph(graphId) {
    return this.active().filter((b) => b.graphId === graphId);
  }

  /**
   * 投递成功建绑定。强制不变量①②。
   * @returns 新绑定（含签发的 runId 世代）
   */
  open({ graphId, graphVersion, taskId, sessionId, channel }, now = new Date()) {
    const onTask = this.byTask(taskId);
    if (onTask) {
      throw new BindingConflictError("任务已有活跃绑定", `task=${taskId} run=${onTask.runId}`);
    }
    const onSession = this.bySession(sessionId);
    if (onSession) {
      throw new BindingConflictError("会话已挂活跃绑定", `session=${sessionId} task=${onSession.taskId}`);
    }
    const binding = {
      graphId,
      graphVersion,
      taskId,
      runId: `r-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      sessionId,
      channel,
      state: "active",
      dispatchedAt: now.toISOString(),
      startedAt: now.toISOString(),
      lastEventSeq: 0,
    };
    this.bindings.push(binding);
    this.#persist();
    return binding;
  }

  /** 任务终态关绑定（留痕在 events/runs，台账条目移除） */
  close(taskId, { outcome } = {}) {
    const b = this.byTask(taskId);
    if (!b) return null;
    b.state = "closed";
    b.closedAt = new Date().toISOString();
    b.outcome = outcome ?? null;
    this.bindings = this.bindings.filter((x) => x !== b);
    this.#persist();
    return b;
  }

  /**
   * 世代校验：交卷/探活回报必须持当前世代 runId。
   * @returns 当前绑定；世代不符抛 stale-run，无绑定抛 binding-conflict
   */
  assertCurrent(taskId, runId) {
    const b = this.byTask(taskId);
    if (!b) throw new BindingConflictError("任务无活跃绑定", `task=${taskId}`);
    if (b.runId !== runId) throw new StaleRunError(taskId, runId);
    return b;
  }

  /** 探活游标：记录该绑定看到的最后事件 seq */
  touchEventSeq(taskId, seq) {
    const b = this.byTask(taskId);
    if (b && seq > b.lastEventSeq) {
      b.lastEventSeq = seq;
      this.#persist();
    }
  }

  /** 人裁重派：关闭旧绑定（若有），由调用方随后 open 新绑定（新 runId 自然成为新世代） */
  supersede(taskId, { reason } = {}) {
    return this.close(taskId, { outcome: `superseded: ${reason ?? "人裁"}` });
  }
}
