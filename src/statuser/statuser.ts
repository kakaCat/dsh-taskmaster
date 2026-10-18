// 量化视图（FR-9 / IF-4）：tm_status 的唯一数据源。
// 纪律：全部从图 + 状态投影 + 绑定台账 + 计划卡派生，无第二事实源；
// 只读接口不失败（graphId 不存在 → 空结果 + notice）。
// 字段：kind/story/里程碑计数、波次、等待关系（在等谁）、生命周期态、活性投影。
// 燃尽等增强后置（S2）。

import { computeReady } from "../scheduler/scheduler.ts";
import { readProjection } from "../persister/projection-store.ts";
import { join } from "node:path";

/** 波次 = 拓扑层（longest-path 深度）：第 0 波无依赖，第 N 波最深 */
export function computeWaves(graph: any) {
  const byId = new Map<string, any>(graph.tasks.map((t: any) => [t.id, t]));
  const depth = new Map();
  const d = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0; // 环防御（注册期已拒，双保险）
    const t = byId.get(id);
    if (!t) return 0;
    seen.add(id);
    const deps = (t.deps ?? []).filter((x) => byId.has(x));
    const v = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((x) => d(x, seen)));
    depth.set(id, v);
    return v;
  };
  for (const t of graph.tasks) d(t.id);
  const waves: any[] = [];
  for (const t of graph.tasks) {
    const w = depth.get(t.id);
    (waves[w] ??= []).push(t.id);
  }
  return waves;
}

export class Statuser {
  dataRoot: string;
  store: any;
  binder: any;
  gate: any;
  constructor(dataRoot, { store, binder, gate }: any) {
    this.dataRoot = dataRoot;
    this.store = store;
    this.binder = binder;
    this.gate = gate;
  }

  /**
   * tm_status 投影。
   * @param graphId 省略 = 全部图总览；给出 = 单图视图
   * @param groupBy "kind"|"story"|"milestone" 分组计数
   * @param taskId 单任务详情
   */
  status({ graphId, groupBy, taskId }: any = {}) {
    if (!graphId) {
      return {
        graphs: this.store.list().map((gid) => {
          const meta = this.store.meta(gid);
          const st = readProjection(join(this.dataRoot, "state", `${gid}.state.json`)).data ?? {};
          const counts: any = {};
          for (const e of Object.values(st) as any[]) counts[e.status] = (counts[e.status] ?? 0) + 1;
          return { graphId: gid, version: meta.activeVersion, lifecycle: meta.lifecycle, counts };
        }),
      };
    }

    const meta = this.store.meta(graphId);
    const graph = this.store.get(graphId);
    const statusMap = readProjection(join(this.dataRoot, "state", `${graphId}.state.json`)).data ?? {};
    const statusOf = (id) => statusMap[id]?.status ?? "pending";

    if (taskId) {
      const task = graph.tasks.find((t) => t.id === taskId);
      if (!task) return { notice: `任务 ${taskId} 不在图 ${graphId}@${meta.activeVersion}` };
      const binding = this.binder.byTask(taskId);
      return {
        graphId,
        taskId,
        status: statusOf(taskId),
        liveness: binding?.liveness ?? null, // 活性投影（不进状态机）
        runId: binding?.runId ?? null,
        waitingOn: (task.deps ?? []).filter((d) => statusOf(d) !== "done"),
        checks: task.checks,
      };
    }

    const readyInfo = computeReady(graph, statusMap);
    const counts: any = {};
    for (const t of graph.tasks) {
      const s = statusOf(t.id);
      counts[s] = (counts[s] ?? 0) + 1;
    }
    const view: any = {
      graphId,
      version: meta.activeVersion,
      lifecycle: meta.lifecycle,
      counts,
      done: readyInfo.done.length,
      total: graph.tasks.length,
      waves: computeWaves(graph),
      ready: readyInfo.ready.map((t) => t.id),
      waiting: readyInfo.waiting.map((w) => ({ taskId: w.task.id, pendingDeps: w.pendingDeps })), // 在等谁
      inFlight: readyInfo.inFlight.map((t) => {
        const b = this.binder.byTask(t.id);
        return { taskId: t.id, status: statusOf(t.id), liveness: b?.liveness ?? null, runId: b?.runId ?? null };
      }),
      plan: this.gate.current(graphId)
        ? (({ planId, state, batch, conflicts, concurrency }) => ({ planId, state, batch, conflicts, concurrency }))(this.gate.current(graphId))
        : null,
    };
    if (groupBy) {
      const groups: any = {};
      for (const t of graph.tasks) {
        const key = t[groupBy] ?? "（未分组）";
        (groups[key] ??= { total: 0, done: 0 });
        groups[key].total++;
        if (statusOf(t.id) === "done") groups[key].done++;
      }
      view.groupBy = { field: groupBy, groups };
    }
    return view;
  }
}
