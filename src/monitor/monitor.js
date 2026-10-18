// 在途探活（FR-7，S1 = 被动心跳）：读三层活性信号，分级，上报落盘。
// 纪律：
//   - 活性是投影，不进主状态机——本模块绝不改任务 status，stalled/dead 只是标记 + 上报；
//   - 只报不修（R-8）：stalled/dead 的唯一动作是 append 事件 + reports/ 落盘，等人裁；
//   - S1 只读被动信号（执行者会话事件 seq 增长 / 进程存活）；主动探活是 S2（#16）。
// 信号适配器注入：activityOf(sessionId)→seq（执行者会话事件游标）、
// processAlive(sessionId)→boolean（进程存活）。真实实现接宿主会话/进程 API。

import { join } from "node:path";
import { atomicWriteFileSync } from "../persister/atomic-write.js";
import { EventLog } from "../persister/event-log.js";

export class Monitor {
  /**
   * @param dataRoot 数据根
   * @param binder Binder 实例
   * @param adapters { activityOf?, processAlive? } 活性信号适配器
   * @param silentMs 无信号增长超过该毫秒数 → stalled（节拍 TTL，S1 全局值）
   */
  constructor(dataRoot, { binder, adapters = {}, silentMs = 90_000 } = {}) {
    this.dataRoot = dataRoot;
    this.binder = binder;
    this.adapters = adapters;
    this.silentMs = silentMs;
  }

  #eventLog(graphId) {
    return EventLog.open(join(this.dataRoot, "events", `${graphId}.events.ndjson`));
  }

  /**
   * 单图巡检：对每条活跃绑定评估活性。
   * @returns Array<{ taskId, liveness: "alive"|"silent"|"stalled"|"dead" }>
   */
  sweep(graphId, now = new Date()) {
    const events = this.#eventLog(graphId);
    const results = [];
    for (const b of this.binder.byGraph(graphId)) {
      // 信号一：进程存活（有适配器才查）
      const proc = this.adapters.processAlive?.(b.sessionId) ?? true;
      if (!proc) {
        this.#mark(b, "dead", events, now);
        results.push({ taskId: b.taskId, liveness: "dead" });
        continue;
      }
      // 信号二：留痕心跳（执行者会话事件 seq 是否增长）
      const activity = this.adapters.activityOf?.(b.sessionId) ?? null;
      const grew = activity !== null && activity > (b.lastEventSeq ?? 0);
      if (grew) {
        this.binder.touchEventSeq(b.taskId, activity);
        this.binder.markLiveness(b.taskId, { liveness: "alive", lastActivityAt: now.toISOString() });
        results.push({ taskId: b.taskId, liveness: "alive" });
        continue;
      }
      // 无增长：按沉默时长分级
      const lastAt = Date.parse(b.lastActivityAt ?? b.startedAt);
      const silentFor = now.getTime() - lastAt;
      if (silentFor > this.silentMs) {
        this.#mark(b, "stalled", events, now);
        results.push({ taskId: b.taskId, liveness: "stalled" });
      } else {
        this.binder.markLiveness(b.taskId, { liveness: "silent" });
        results.push({ taskId: b.taskId, liveness: "silent" });
      }
    }
    return results;
  }

  /** 标记 + 事件 + 上报落盘（唯一动作；绝不派发、绝不重跑）。活性是投影：执行者自己活过来可回 alive，但已上报的留痕不撤。 */
  #mark(binding, liveness, events, now) {
    if (binding.liveness === liveness) return; // 已报过，不重复上报
    this.binder.markLiveness(binding.taskId, { liveness });
    events.append(liveness === "dead" ? "dead" : "stall", {
      taskId: binding.taskId,
      runId: binding.runId,
      sessionId: binding.sessionId,
    });
    atomicWriteFileSync(
      join(this.dataRoot, "reports", `${now.toISOString().replaceAll(":", "-")}-${liveness}-${binding.taskId}.json`),
      JSON.stringify(
        { kind: liveness, graphId: binding.graphId, taskId: binding.taskId, runId: binding.runId, sessionId: binding.sessionId, at: now.toISOString() },
        null,
        2,
      ),
    );
  }
}
