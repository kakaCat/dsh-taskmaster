// 绑定台账（FR-14）：(graphId, graphVersion, taskId, runId) 四元组唯一 + sessionId 寻址。
// 薄模块：存储复用 persister（bindings.json 走原子写）；本模块的价值是不变量强制——
//   ① 任务同时刻 ≤1 条活跃绑定（CAS 占位的台账侧）
//   ② 同一 sessionId 不出现在两条活跃绑定（一窗口一单活）
//   ③ 世代：新绑定签发新 runId，旧世代回话 stale-run 拒收
// 历史不在这里：终态关绑定，永久留痕在 events/ 与 runs/。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { atomicWriteFileSync } from "../persister/atomic-write.ts";
import type { BindingRecord } from "../types.ts";

export class BindingConflictError extends Error {
  code: string;
  constructor(reason, detail) {
    super(`binding conflict: ${reason} (${detail})`);
    this.code = "binding-conflict";
  }
}

export class StaleRunError extends Error {
  code: string;
  constructor(taskId, runId) {
    super(`stale run: task ${taskId} rejected runId ${runId}`);
    this.code = "stale-run";
  }
}

export class Binder {
  path: string;
  bindings: BindingRecord[];
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

  /** 寻址查询忽略未挂会话的预留绑定 */
  bySession(sessionId) {
    if (!sessionId) return null;
    return this.active().find((b) => b.sessionId === sessionId) ?? null;
  }

  /**
   * 预留绑定：先签发 runId 世代（任务包必须携带世代凭据，FR-10），sessionId 投递成功后补挂。
   * 不变量①在此强制；不变量②在 attachSession 强制。
   */
  reserve({ graphId, graphVersion, taskId, channel }: Pick<BindingRecord, "graphId" | "graphVersion" | "taskId"> & { channel?: string | null }, now: Date = new Date()): BindingRecord {
    const onTask = this.byTask(taskId);
    if (onTask) {
      throw new BindingConflictError("任务已有活跃绑定", `task=${taskId} run=${onTask.runId}`);
    }
    const binding: BindingRecord = {
      graphId,
      graphVersion,
      taskId,
      runId: `r-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      sessionId: null,
      channel: channel ?? null,
      state: "active",
      dispatchedAt: now.toISOString(),
      startedAt: now.toISOString(),
      lastEventSeq: 0,
    };
    this.bindings.push(binding);
    this.#persist();
    return binding;
  }

  /** 投递成功后补挂会话与通道；同一 sessionId 不出现在两条活跃绑定（不变量②） */
  attachSession(taskId: string, runId: string, sessionId: string, channel: string | null = null): BindingRecord {
    const b = this.byTask(taskId);
    if (!b || b.runId !== runId) throw new BindingConflictError("预留绑定不存在或世代不符", `task=${taskId} run=${runId}`);
    const onSession = this.bySession(sessionId);
    if (onSession && onSession !== b) {
      throw new BindingConflictError("会话已挂活跃绑定", `session=${sessionId} task=${onSession.taskId}`);
    }
    b.sessionId = sessionId;
    if (channel) b.channel = channel;
    this.#persist();
    return b;
  }

  /** 投递失败回收预留（不自动重试的台账侧） */
  drop(taskId: string, runId: string): void {
    const b = this.byTask(taskId);
    if (b && b.runId === runId) {
      this.bindings = this.bindings.filter((x) => x !== b);
      this.#persist();
    }
  }

  /** 投递成功建绑定（= reserve + attachSession 的便捷组合，测试与同步路径用） */
  open({ graphId, graphVersion, taskId, sessionId, channel }: { graphId: string; graphVersion: number; taskId: string; sessionId: string; channel?: string | null }, now: Date = new Date()): BindingRecord {
    const b = this.reserve({ graphId, graphVersion, taskId, channel }, now);
    return this.attachSession(taskId, b.runId, sessionId);
  }

  byGraph(graphId) {
    return this.active().filter((b) => b.graphId === graphId);
  }

  /** 任务终态关绑定（留痕在 events/runs，台账条目移除） */
  close(taskId: string, { outcome }: { outcome?: string | null } = {}): BindingRecord | null {
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
  assertCurrent(taskId: string, runId: string): BindingRecord {
    const b = this.byTask(taskId);
    if (!b) throw new BindingConflictError("任务无活跃绑定", `task=${taskId}`);
    if (b.runId !== runId) throw new StaleRunError(taskId, runId);
    return b;
  }

  /** 探活游标：记录该绑定看到的最后事件 seq */
  touchEventSeq(taskId: string, seq: number): void {
    const b = this.byTask(taskId);
    if (b && seq > b.lastEventSeq) {
      b.lastEventSeq = seq;
      this.#persist();
    }
  }

  /** 监控元数据：活性投影与最后活动时间（投影，不进主状态机；由 monitor 写入） */
  markLiveness(taskId: string, { liveness, lastActivityAt }: { liveness?: BindingRecord["liveness"]; lastActivityAt?: string } = {}): void {
    const b = this.byTask(taskId);
    if (!b) return;
    if (liveness !== undefined) b.liveness = liveness;
    if (lastActivityAt !== undefined) b.lastActivityAt = lastActivityAt;
    this.#persist();
  }

  /** 人裁重派：关闭旧绑定（若有），由调用方随后 open 新绑定（新 runId 自然成为新世代） */
  supersede(taskId: string, { reason }: { reason?: string } = {}): BindingRecord | null {
    return this.close(taskId, { outcome: `superseded: ${reason ?? "人裁"}` });
  }
}
