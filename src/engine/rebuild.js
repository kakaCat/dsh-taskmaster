// 崩溃重建（NFR-5/R-9）：state.json 是投影，事实源 = 图快照 + 事件流。
// 重放规则（按 seq 顺序 fold）：
//   ready → ready；dispatch → running；accept → done；reject → running（打回不翻状态，已在 running）；
//   blocked → blocked；delivery-failed / reconcile-reset-dispatching → ready；
//   其余事件（plan-*/stall/dead/graph-*/register/reconcile-close-binding）不改任务状态。

const FOLD = {
  ready: (e, map) => {
    for (const id of e.tasks ?? []) map[id] = { ...map[id], status: "ready" };
  },
  dispatch: (e, map) => {
    map[e.taskId] = { ...map[e.taskId], status: "running", runId: e.runId };
  },
  accept: (e, map) => {
    map[e.taskId] = { ...map[e.taskId], status: "done", runId: e.runId };
  },
  reject: (e, map) => {
    map[e.taskId] = { ...map[e.taskId], status: "running", runId: e.runId };
  },
  blocked: (e, map) => {
    map[e.taskId] = { ...map[e.taskId], status: "blocked", runId: e.runId, blockReason: e.reason ?? null };
  },
  "delivery-failed": (e, map) => {
    map[e.taskId] = { ...map[e.taskId], status: "ready" };
  },
  "reconcile-reset-dispatching": (e, map) => {
    map[e.taskId] = { ...map[e.taskId], status: "ready" };
  },
};

/**
 * 从图 + 事件流重建状态投影。
 * @returns statusMap（taskId → { status, runId?... }），图里所有任务至少有 pending
 */
export function rebuildProjection(graph, events) {
  const map = {};
  for (const t of graph.tasks) map[t.id] = { status: "pending" };
  for (const e of events) {
    FOLD[e.kind]?.(e, map);
  }
  return map;
}
