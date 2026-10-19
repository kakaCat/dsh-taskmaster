// 在途探活（FR-7，S1 = 被动心跳）：读三层活性信号，分级，上报落盘。
// 纪律：
//   - 活性是投影，不进主状态机——缺省本模块绝不改任务 status，stalled/dead 只是标记 + 上报；
//   - 只报不修（R-8）：stalled/dead 的唯一动作是 append 事件 + reports/ 落盘，等人裁；
//     唯一例外是 autoResume.enabled 显式开启时的 dead 自愈（见 #selfHeal，缺省关闭不改现状）；
//   - S1 只读被动信号（执行者会话事件 seq 增长 / 进程存活）；主动探活是 S2（#16）。
// 信号适配器注入：activityOf(sessionId)→seq（执行者会话事件游标）、
// processAlive(sessionId)→boolean（进程存活）。真实实现接宿主会话/进程 API。

import { join } from "node:path";
import { atomicWriteFileSync } from "../persister/atomic-write.ts";
import { readProjection, casWriteProjection } from "../persister/projection-store.ts";
import { EventLog } from "../persister/event-log.ts";
import { loadConfig } from "../engine/config.ts";

export class Monitor {
  dataRoot: string;
  binder: any;
  adapters: any;
  silentMs: number;
  autoResume: any;
  /**
   * @param dataRoot 数据根
   * @param binder Binder 实例
   * @param adapters { activityOf?, processAlive? } 活性信号适配器
   * @param silentMs 无信号增长超过该毫秒数 → stalled（节拍 TTL，S1 全局值）
   * @param autoResume 自愈开关 { enabled, maxPerTask }；缺省 null = 每拍从 config.yaml 重读（改配置下一拍生效）
   */
  constructor(dataRoot, { binder, adapters = {}, silentMs = 90_000, autoResume = null }: any = {}) {
    this.dataRoot = dataRoot;
    this.binder = binder;
    this.adapters = adapters;
    this.silentMs = silentMs;
    this.autoResume = autoResume;
  }

  #eventLog(graphId) {
    return EventLog.open(join(this.dataRoot, "events", `${graphId}.events.ndjson`));
  }

  /**
   * 单图巡检：对每条活跃绑定评估活性。
   * @returns Array<{ taskId, liveness: "alive"|"silent"|"stalled"|"dead" }>
   */
  async sweep(graphId, now = new Date()) {
    const events = this.#eventLog(graphId);
    const results: any[] = [];
    for (const b of this.binder.byGraph(graphId)) {
      // 信号一：进程存活（有适配器才查）
      const proc = this.adapters.processAlive?.(b.sessionId) ?? true;
      if (!proc) {
        const firstDead = b.liveness !== "dead"; // 只在「新判 dead」这一拍尝试自愈（去重，同人裁不重复上报）
        this.#mark(b, "dead", events, now);
        const heal = firstDead ? this.#selfHeal(b, events, now) : null;
        results.push({ taskId: b.taskId, liveness: "dead", ...(heal ?? {}) });
        continue;
      }
      // 信号二：留痕心跳（执行者会话事件 seq 是否增长）
      const activity = this.adapters.activityOf?.(b.sessionId) ?? null;
      const grew = activity !== null && activity > (b.lastEventSeq ?? 0);
      if (grew) {
        this.binder.touchEventSeq(b.graphId, b.taskId, activity);
        this.binder.markLiveness(b.graphId, b.taskId, { liveness: "alive", lastActivityAt: now.toISOString() });
        results.push({ taskId: b.taskId, liveness: "alive" });
        continue;
      }
      // 无增长：按沉默时长分级（S2：silent → 主动探活一次 → 仍沉默 → stalled）
      const lastAt = Date.parse(b.lastActivityAt ?? b.startedAt);
      const silentFor = now.getTime() - lastAt;
      if (silentFor > this.silentMs) {
        if (!b.probedAt) {
          // 本轮沉默尚未探活：主动探活一次（消息经宿主 sendMessage 寻址）
          b.probedAt = now.toISOString();
          try {
            await this.adapters.probe?.(b.sessionId);
          } catch {
            /* 探活失败不抛：仍沉默下拍判 stalled */
          }
          this.binder.markLiveness(b.graphId, b.taskId, { liveness: "silent" });
          events.append("probe", { taskId: b.taskId, runId: b.runId, sessionId: b.sessionId });
          results.push({ taskId: b.taskId, liveness: "silent", probed: true });
        } else {
          this.#mark(b, "stalled", events, now);
          results.push({ taskId: b.taskId, liveness: "stalled" });
        }
      } else {
        b.probedAt = undefined; // 有活动迹象（回到 TTL 内）→ 探活回合重置
        this.binder.markLiveness(b.graphId, b.taskId, { liveness: "silent" });
        results.push({ taskId: b.taskId, liveness: "silent" });
      }
    }
    return results;
  }

  /** 标记 + 事件 + 上报落盘（唯一动作；绝不派发、绝不重跑）。活性是投影：执行者自己活过来可回 alive，但已上报的留痕不撤。 */
  #mark(binding, liveness, events, now) {
    if (binding.liveness === liveness) return; // 已报过，不重复上报
    this.binder.markLiveness(binding.graphId, binding.taskId, { liveness });
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

  /** 自愈计数：从事件流统计本任务的自动复活次数（事件流是事实源，天然持久化、重启不丢）。
   *  只计 auto:true 的 task-resume；人裁 resume 不占自愈额度。 */
  #healCount(graphId, taskId, events) {
    return events.readAll().filter((e) => e.kind === "task-resume" && e.auto === true && e.taskId === taskId).length;
  }

  /**
   * dead 自愈（autoResume.enabled 显式开启才动作；缺省关闭 = 纯上报的现状行为）。
   * 计数 < maxPerTask：与 tm_task_action resume 同语义——关绑定（supersede）、
   *   投影翻 ready + runId 作废（新世代由下一拍派发签发）、事件留痕。
   *   事件 kind 复用 task-resume（带 auto:true / actor:auto-resume 区分人裁）：
   *   崩溃重建（rebuild.ts）按既有 fold 重放成 ready，零漂移、无需改引擎模块。
   * 计数达上限：翻 blocked + 事件 + reports/ 落盘，回到「只报不修」等人裁。
   * @returns 结果摘要（并入 sweep 返回），未开启返回 null
   */
  #selfHeal(binding, events, now) {
    const cfg = this.autoResume ?? loadConfig(this.dataRoot).autoResume;
    if (!cfg?.enabled) return null;
    const { graphId, taskId } = binding;
    const count = this.#healCount(graphId, taskId, events);
    const statePath = join(this.dataRoot, "state", `${graphId}.state.json`);

    if (count < cfg.maxPerTask) {
      this.binder.supersede(graphId, taskId, { reason: `auto-resume: 进程死亡（第 ${count + 1}/${cfg.maxPerTask} 次自愈）` });
      const proj = readProjection(statePath);
      casWriteProjection(statePath, proj.version, {
        ...proj.data,
        [taskId]: { ...proj.data?.[taskId], status: "ready", runId: null },
      });
      events.append("task-resume", {
        taskId,
        actor: "auto-resume",
        auto: true,
        count: count + 1,
        maxPerTask: cfg.maxPerTask,
        reason: "process dead",
        runId: binding.runId,
      });
      return { autoResumed: true, count: count + 1 };
    }

    // 超上限：落 blocked 等人裁（绑定保留——人裁 resume/reassign 时会 supersede 关旧世代）
    const reason = `auto-resume 达上限（${count}/${cfg.maxPerTask}）：进程死亡，等人裁`;
    const proj = readProjection(statePath);
    casWriteProjection(statePath, proj.version, {
      ...proj.data,
      [taskId]: { ...proj.data?.[taskId], status: "blocked", blockedAt: now.toISOString(), blockReason: reason },
    });
    events.append("blocked", { taskId, runId: binding.runId, reason, autoResumeCount: count });
    atomicWriteFileSync(
      join(this.dataRoot, "reports", `${now.toISOString().replaceAll(":", "-")}-blocked-${taskId}.json`),
      JSON.stringify(
        { kind: "blocked", graphId, taskId, runId: binding.runId, reason, autoResumeCount: count, maxPerTask: cfg.maxPerTask, at: now.toISOString() },
        null,
        2,
      ),
    );
    return { autoResumed: false, exhausted: true, count };
  }
}
