// 常驻对账循环（FR-8，附图 2 的代码化身）：每拍对每张活跃图全量对账。
// 对账顺序（先收账再开新账）：
//   ① 漂移修复：done 但绑定开着→补关；dispatching 无绑定→回 ready；running 无绑定→上报漂移
//   ② 在途探活（monitor.sweep，paused/stopping 图也照做）
//   ③ 图状态分流：paused 不派发；stopping 清点收口；asleep/deregistered 跳过
//   ④ active：完成判定→asleep；死锁嗅探→上报（去重）；已确认未派发→补投递；出/更新计划卡
// 纪律：事件只是即时加速，心跳是兜底；本模块任何路径都不自动重跑任务（R-8/NFR-1）。

import { join } from "node:path";
import { createHash } from "node:crypto";
import { readProjection, casWriteProjection } from "../persister/projection-store.ts";
import { atomicWriteFileSync } from "../persister/atomic-write.ts";
import { EventLog } from "../persister/event-log.ts";
import { computeReady, selectBatch, isDeadlocked, isComplete, dispatchableTasks } from "../scheduler/scheduler.ts";
import { DeliveryFailedError } from "../deliverer/deliverer.ts";

const IN_FLIGHT = new Set(["dispatching", "running"]);

export class Reconciler {
  dataRoot: string;
  store: any;
  binder: any;
  gate: any;
  deliverer: any;
  monitor: any;
  autoFacets: string[];
  guard: any;
  deadlockReported: Map<string,string>;
  /**
   * @param dataRoot 数据根
   * @param deps { store: GraphStore, binder: Binder, gate: Gate, deliverer: Deliverer, monitor: Monitor, autoFacets?: string[] }
   */
  constructor(dataRoot, { store, binder, gate, deliverer, monitor, autoFacets = [], guard = null }: any) {
    this.dataRoot = dataRoot;
    this.store = store;
    this.binder = binder;
    this.gate = gate;
    this.deliverer = deliverer;
    this.monitor = monitor;
    this.autoFacets = autoFacets;
    this.guard = guard; // null = 宽松（测试/独立使用）；引擎装配必带（#13）
    this.deadlockReported = new Map(); // graphId → waiting 集哈希（去重，重启后重复报一次可接受）
  }

  #eventLog(graphId) {
    return EventLog.open(join(this.dataRoot, "events", `${graphId}.events.ndjson`));
  }

  #statePath(graphId) {
    return join(this.dataRoot, "state", `${graphId}.state.json`);
  }

  /** 全部图一拍（引擎心跳的顶层入口） */
  async reconcileAll(now = new Date()) {
    const out: any[] = [];
    for (const graphId of this.store.list()) {
      out.push(await this.reconcileGraph(graphId, now));
    }
    return out;
  }

  /** 单图一拍 */
  async reconcileGraph(graphId, now = new Date()) {
    const events = this.#eventLog(graphId);
    const meta = this.store.meta(graphId);
    const lc = meta.lifecycle;
    const summary: any = { graphId, lifecycle: lc, actions: [] };

    if (lc === "asleep" || lc === "deregistered") {
      summary.skipped = true;
      return summary;
    }

    const graph = this.store.get(graphId);
    const proj = readProjection(this.#statePath(graphId));
    const statusMap = proj.data ?? {};

    // ① 漂移修复
    const bindings = this.binder.byGraph(graphId);
    for (const [taskId, entry] of Object.entries(statusMap) as [string, any][]) {
      const b = bindings.find((x) => x.taskId === taskId);
      if (entry.status === "done" && b) {
        this.binder.close(taskId, { outcome: "reconcile-close" });
        events.append("reconcile-close-binding", { taskId, runId: b.runId });
        summary.actions.push(`close-binding:${taskId}`);
      }
      if (entry.status === "dispatching" && !b) {
        // 崩溃在投递中途：回 ready，等本拍重新走闸
        const back = readProjection(this.#statePath(graphId));
        casWriteProjection(this.#statePath(graphId), back.version, {
          ...back.data,
          [taskId]: { ...back.data[taskId], status: "ready" },
        });
        events.append("reconcile-reset-dispatching", { taskId });
        summary.actions.push(`reset-dispatching:${taskId}`);
      }
      if (entry.status === "running" && !b) {
        // 投影/台账漂移：任务在跑但台账没账——只上报不动作
        atomicWriteFileSync(
          join(this.dataRoot, "reports", `${now.toISOString().replaceAll(":", "-")}-drift-${taskId}.json`),
          JSON.stringify({ kind: "drift", graphId, taskId, at: now.toISOString() }, null, 2),
        );
        events.append("drift", { taskId });
        summary.actions.push(`drift:${taskId}`);
      }
    }

    // 总开关关闭：不派发不探活（漂移修复是对账簿记，照常）
    if (this.guard && !this.guard.allowMonitor()) {
      summary.actions.push("disabled-skip");
      return summary;
    }

    // ② 在途探活（paused/stopping 也照做——R-17/R-18 暂停停止不停盯）
    const liveness = this.monitor.sweep(graphId, now);
    if (liveness.length > 0) summary.liveness = liveness;

    // ③ 状态分流
    if (lc === "paused") return summary;
    if (lc === "stopping") {
      const remaining = (Object.values(statusMap) as any[]).filter((e) => IN_FLIGHT.has(e.status));
      if (remaining.length === 0 && this.binder.byGraph(graphId).length === 0) {
        this.store.setLifecycle(graphId, "stopped");
        summary.actions.push("stopped");
        summary.lifecycle = "stopped";
      }
      return summary;
    }

    // ④ active 全量对账
    // 完成判定（级联解锁后图可能全 done）
    if (isComplete(graph, statusMap)) {
      this.store.setLifecycle(graphId, "asleep");
      summary.actions.push("asleep");
      summary.lifecycle = "asleep";
      return summary;
    }

    // 已确认未派发（崩溃在 confirm 与投递之间）→ 补投递。
    // 必须先于就绪空早退：confirmed 批次的任务状态已是 ready，不在就绪计算里。
    const card = this.gate.current(graphId);
    if (card?.state === "confirmed") {
      const deliverable = card.batch
        .map((item) => graph.tasks.find((t) => t.id === item.taskId))
        .filter((task) => task && (statusMap[task.id]?.status ?? "pending") === "ready");
      if (deliverable.length > 0) {
        // 批次还有未派出的 ready 任务：要么补投递，要么（降级中）等——绝不落出卡逻辑覆盖已确认的卡
        if (this.guard && !this.guard.allowDispatch()) {
          summary.actions.push("dispatch-skipped-degraded");
          return summary;
        }
        for (const task of deliverable) {
          try {
            const r = await this.deliverer.deliver({ graphId, graphVersion: card.graphVersion, graph, task }, now);
            summary.actions.push(`delivered:${task.id}:${r.runId}`);
          } catch (e: any) {
            if (e instanceof DeliveryFailedError) {
              this.guard?.markDegraded("all-channels-down");
              summary.actions.push(`delivery-failed:${task.id}`);
            } else throw e;
          }
        }
        return summary;
      }
      // 批次全部派出（无 ready 剩余）→ 落到下方出卡逻辑，为新的就绪集出下一批卡
    }

    const readyInfo = computeReady(graph, statusMap);

    // 就绪物化：把计算出的 ready 写进投影（pending→ready）——deliverer 的占位输入；
    // 这也是"期望=图，实际=投影"的对账动作之一
    const newlyReady = readyInfo.ready.filter((t) => (statusMap[t.id]?.status ?? "pending") === "pending");
    if (newlyReady.length > 0) {
      const cur = readProjection(this.#statePath(graphId));
      const next = { ...cur.data };
      for (const t of newlyReady) next[t.id] = { ...next[t.id], status: "ready" };
      casWriteProjection(this.#statePath(graphId), cur.version, next);
      events.append("ready", { tasks: newlyReady.map((t) => t.id) });
      for (const t of newlyReady) statusMap[t.id] = { ...statusMap[t.id], status: "ready" };
      summary.actions.push(`ready:${newlyReady.map((t) => t.id).join(",")}`);
    }

    // 死锁嗅探（去重上报）与空集早退：以「可派发集合」为准（pending+ready 同口径）
    const dispatchable = dispatchableTasks(graph, statusMap);
    if (dispatchable.length === 0) {
      if (isDeadlocked(readyInfo)) {
        const hash = createHash("sha1")
          .update(readyInfo.waiting.map((w) => w.task.id).sort().join(","))
          .digest("hex")
          .slice(0, 12);
        if (this.deadlockReported.get(graphId) !== hash) {
          this.deadlockReported.set(graphId, hash);
          atomicWriteFileSync(
            join(this.dataRoot, "reports", `${now.toISOString().replaceAll(":", "-")}-deadlock-${graphId}.json`),
            JSON.stringify(
              { kind: "deadlock", graphId, waiting: readyInfo.waiting.map((w) => ({ taskId: w.task.id, pendingDeps: w.pendingDeps })), at: now.toISOString() },
              null,
              2,
            ),
          );
          events.append("deadlock", { waiting: readyInfo.waiting.map((w) => w.task.id) });
          summary.actions.push("deadlock-reported");
        }
      }
      return summary;
    }

    // 有 pending 卡 → 等人（不重复出卡，gate 内部幂等）
    const cardNow = this.gate.current(graphId);
    if (cardNow?.state === "pending") return summary;

    // 出/更新计划卡（口径与 confirm 端一致：dispatchable）
    const batch = selectBatch(dispatchable, { limit: 1 }); // S1 串行
    const offered = this.gate.offer(
      { graphId, graphVersion: meta.activeVersion, ready: dispatchable, batch, concurrency: 1, autoFacets: this.autoFacets },
      now,
    );
    if (offered.suppressedByReject) {
      summary.actions.push("plan-suppressed-by-reject");
      return summary;
    }
    if (offered.autoConfirmed) {
      // gate=auto 切面：免确认直接投递（降级时跳过，卡已由 gate 确认，恢复后由 confirmed 分支补投递）
      if (this.guard && !this.guard.allowDispatch()) {
        summary.actions.push("dispatch-skipped-degraded");
        return summary;
      }
      const task = batch[0];
      try {
        const r = await this.deliverer.deliver({ graphId, graphVersion: meta.activeVersion, graph, task }, now);
        summary.actions.push(`delivered:${task.id}:${r.runId}`);
      } catch (e: any) {
        if (e instanceof DeliveryFailedError) {
          this.guard?.markDegraded("all-channels-down");
          summary.actions.push(`delivery-failed:${task.id}`);
        } else throw e;
      }
      return summary;
    }
    if (offered.isNew) summary.actions.push(`plan-offered:${offered.card.planId}`);
    return summary;
  }
}
