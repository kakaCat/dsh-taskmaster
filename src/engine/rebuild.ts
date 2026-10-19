// 崩溃重建（NFR-5/R-9）：state.json 是投影，事实源 = 图快照 + 事件流。
// 重放规则（按 seq 顺序 fold）：
//   ready → ready；dispatch → running；accept → done；reject → running（打回不翻状态，已在 running）；
//   blocked → blocked；delivery-failed / reconcile-reset-dispatching → ready；
//   人裁（tools.ts 的 taskAction 留痕）：task-resume / task-reassign → ready，task-reopen → pending
//   ——漏掉这三条 = 重启后人裁凭空消失（reopen 的 done→pending 回弹成 done，永不再干）。
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
  // 人裁新世代：投影侧 taskAction 已把 runId 置 null（旧世代凭据作废），重放保持同口径
  "task-resume": (e, map) => {
    map[e.taskId] = { ...map[e.taskId], status: "ready", runId: null };
  },
  "task-reassign": (e, map) => {
    map[e.taskId] = { ...map[e.taskId], status: "ready", runId: null };
  },
  "task-reopen": (e, map) => {
    map[e.taskId] = { ...map[e.taskId], status: "pending", runId: null };
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
