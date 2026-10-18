// 投递（FR-10 / IF-8）：CAS 占位 → 通道降级链 → 建绑定 / 失败回滚。
// 纪律：
//   - 占位先于投递：任务 ready→dispatching（投影 CAS），并发触发第二个直接 write-conflict；
//   - at-most-once：占位 + binder 不变量双保险，同任务同世代最多一个在途 run；
//   - 失败回滚：任何一步失败 → 回 ready、零绑定残留、不自动重试；
//   - 每次投递尝试（含失败）在 runs/ 留痕；
//   - 通道降级链：startActivation → branch → spawn → 纯对话流（全挂 = 降级出卡，不派送）。
// 通道是注入的适配器：真实实现接宿主 subagent/window service（live parent 约束见 IF-8），
// 测试用假通道。通道函数签名：async (taskPackage) => { sessionId }。

import { join } from "node:path";
import { atomicWriteFileSync } from "../persister/atomic-write.ts";
import { readProjection, casWriteProjection } from "../persister/projection-store.ts";
import { EventLog } from "../persister/event-log.ts";

export class DeliveryConflictError extends Error {
  code: string;
  constructor(taskId, status) {
    super(`task ${taskId} not ready for dispatch (status=${status})`);
    this.code = "dispatch-conflict";
  }
}

export class DeliveryFailedError extends Error {
  code: string;
  attempts: any[];
  constructor(taskId, attempts) {
    super(`delivery failed for ${taskId}: all channels unavailable`);
    this.code = "delivery-failed";
    this.attempts = attempts;
  }
}

/**
 * 执行面暂时未就绪（服务尚未 active / provider 尚未注册）——**不是失败**。
 * 典型场景：宿主重启后首拍立即对账，而 subagents 插件比本插件晚一拍 active；
 * 此时若按 DeliveryFailed 处理会置 degraded 且不再重试（只能人工 tm_engine_start）。
 * 语义：任务留在 ready，下一拍再看，不占位、不留失败痕、不降级。
 */
export class DeliveryDeferredError extends Error {
  code: string;
  taskId: string;
  constructor(taskId, detail = "execution surface not ready yet") {
    super(`delivery deferred for ${taskId}: ${detail}`);
    this.code = "delivery-deferred";
    this.taskId = taskId;
  }
}

/** 默认通道优先级（IF-8）；"conversation" 不在链里——全挂时由调用方转纯对话流 */
export const CHANNEL_ORDER = ["startActivation", "branch", "spawn"];

/** 任务包组装（FR-5 视野最小化 + FR-10 世代凭据）：只含本任务投影 + runId + 前驱产物的路径+摘要 */
export function assemblePackage(graph: any, task: any, { artifacts = {}, binding = {} }: any = {}) {
  return {
    graphId: binding.graphId,
    graphVersion: binding.graphVersion,
    taskId: task.id,
    runId: binding.runId ?? null, // 世代凭据：交卷只认它
    statement: task.statement,
    deps: (task.deps ?? []).map((d) => ({
      taskId: d,
      artifact: artifacts[d] ?? null, // { path, summary }；大产物只给路径+摘要
    })),
    checks: task.checks,
    writeScopes: task.writeScopes ?? [],
    roundBudget: task.roundBudget ?? null,
    // 注意：不含任何非入边任务信息——视野最小化由这个组装函数唯一保证
  };
}

export class Deliverer {
  dataRoot: string;
  channels: any;
  binder: any;
  /**
   * @param dataRoot 数据根
   * @param channels { startActivation?, branch?, spawn? } 通道适配器
   * @param binder Binder 实例
   */
  constructor(dataRoot, { channels = {}, binder }: any = {}) {
    this.dataRoot = dataRoot;
    this.channels = channels;
    this.binder = binder;
  }

  #statePath(graphId) {
    return join(this.dataRoot, "state", `${graphId}.state.json`);
  }

  #eventLog(graphId) {
    return EventLog.open(join(this.dataRoot, "events", `${graphId}.events.ndjson`));
  }

  /**
   * 投递一个任务。
   * @returns {{ delivered: true, runId, sessionId, channel } }
   * @throws DeliveryConflictError 任务不在 ready（并发触发/状态异常）
   * @throws DeliveryDeferredError 执行面暂时未就绪（不占位、不降级，下拍重试）
   * @throws DeliveryFailedError 全部通道不可用（已回滚，可下拍再来——由人或对账决定）
   */
  async deliver({ graphId, graphVersion, graph, task }, now = new Date()) {
    const statePath = this.#statePath(graphId);
    const events = this.#eventLog(graphId);

    // ⓪ 执行面就绪检查（启动期竞态）：未就绪 = 延迟，不是失败。
    // 必须在 CAS 占位之前判断，否则会平白制造 dispatching→ready 的抖动。
    if (typeof this.channels.available === "function" && !this.channels.available()) {
      if (this.channels.pending?.()) throw new DeliveryDeferredError(task.id, "subagents/window service not active yet");
      // 服务确实不存在（宿主没有执行面）：继续走通道，由 DeliveryFailed 如实降级
    }

    // ① CAS 占位：ready → dispatching
    const proj = readProjection(statePath);
    const statusMap = proj.data ?? {};
    const current = statusMap[task.id]?.status ?? "pending";
    if (current !== "ready") throw new DeliveryConflictError(task.id, current);
    casWriteProjection(statePath, proj.version, {
      ...statusMap,
      [task.id]: { ...statusMap[task.id], status: "dispatching", graphVersion },
    });

    // ② 预留绑定：世代先签发（任务包必须携带 runId）
    const reserved = this.binder.reserve({ graphId, graphVersion, taskId: task.id, channel: null }, now);

    // ③ 逐档尝试通道
    const attempts: any[] = [];
    let sessionId: string | null = null;
    let usedChannel: string | null = null;
    for (const name of CHANNEL_ORDER) {
      const channel = this.channels[name];
      if (!channel) {
        attempts.push({ channel: name, ok: false, error: "unavailable" });
        continue;
      }
      try {
        const pkg = assemblePackage(graph, task, { binding: reserved });
        const r = await channel(pkg);
        sessionId = r.sessionId;
        usedChannel = name;
        attempts.push({ channel: name, ok: true });
        break;
      } catch (e: any) {
        attempts.push({ channel: name, ok: false, error: String(e?.message ?? e) });
      }
    }

    // ④ 全挂 → 回收预留 + 回滚 + 失败留痕，不自动重试
    if (!sessionId) {
      this.binder.drop(task.id, reserved.runId);
      const back = readProjection(statePath);
      casWriteProjection(statePath, back.version, {
        ...back.data,
        [task.id]: { ...back.data[task.id], status: "ready" },
      });
      this.#record({ graphId, taskId: task.id, runId: null, attempts, result: "failed" }, now);
      events.append("delivery-failed", { taskId: task.id, attempts: attempts.length });
      throw new DeliveryFailedError(task.id, attempts);
    }

    // ⑤ 补挂会话（不变量②在此强制）；冲突 → 回收 + 回滚
    let binding;
    try {
      binding = this.binder.attachSession(task.id, reserved.runId, sessionId, usedChannel);
    } catch (e: any) {
      this.binder.drop(task.id, reserved.runId);
      const back = readProjection(statePath);
      casWriteProjection(statePath, back.version, {
        ...back.data,
        [task.id]: { ...back.data[task.id], status: "ready" },
      });
      this.#record({ graphId, taskId: task.id, runId: null, attempts, result: "binding-conflict" }, now);
      events.append("delivery-failed", { taskId: task.id, stage: "bind", error: e.code });
      throw e;
    }

    // ⑤ dispatching → running + 成功留痕
    const after = readProjection(statePath);
    casWriteProjection(statePath, after.version, {
      ...after.data,
      [task.id]: { ...after.data[task.id], status: "running", runId: binding.runId },
    });
    this.#record(
      { graphId, taskId: task.id, runId: binding.runId, attempts, result: "delivered", channel: usedChannel, sessionId },
      now,
    );
    events.append("dispatch", { taskId: task.id, runId: binding.runId, channel: usedChannel });
    return { delivered: true, runId: binding.runId, sessionId, channel: usedChannel };
  }

  /** 投递留痕：成功按 runId 归档；失败按 时间+任务 归档（都在 runs/ 下永久保留） */
  #record(payload, now) {
    const name = payload.runId
      ? join("runs", payload.runId, "delivery.json")
      : join("runs", "failed", `${now.toISOString().replaceAll(":", "-")}-${payload.taskId}.json`);
    atomicWriteFileSync(join(this.dataRoot, name), JSON.stringify({ ...payload, at: now.toISOString() }, null, 2));
  }
}
