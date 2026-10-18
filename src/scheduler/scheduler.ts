import type { Graph, Task, StatusMap } from "../types.ts";

// 就绪计算（FR-2）：任何派发路径共享的唯一入口。
// 纪律：只有「全部前驱 done」的任务能进就绪集——无论触发来自工具、心跳对账还是重启续调。
// 无依赖任务默认同批并行（并发上限见 config.concurrency，缺省 8 ≈ 宿主 maxActiveSubagents）；
// 写域裁决见 arbitrate（#15）：只有真冲突（同文件/目录包含）才串行。

/**
 * 从图 + 状态投影算就绪集与等待关系。
 * @param graph 图对象（vN.yaml 解析结果）
 * @param statusMap taskId → status（缺省视为 pending）
 * @returns {{ ready: Task[], waiting: Array<{task: Task, pendingDeps: string[]}>, inFlight: Task[], done: Task[] }}
 */
export interface ReadyInfo {
  ready: Task[];
  waiting: Array<{ task: Task; pendingDeps: string[] }>;
  inFlight: Task[];
  done: Task[];
}

export function computeReady(graph: Graph, statusMap: StatusMap = {}): ReadyInfo {
  const statusOf = (id: string) => statusMap[id]?.status ?? "pending";
  const ready: any[] = [];
  const waiting: any[] = [];
  const inFlight: any[] = [];
  const done: any[] = [];
  for (const task of graph.tasks) {
    const st = statusOf(task.id);
    if (st === "done") {
      done.push(task);
      continue;
    }
    // ready = 已物化但尚未派发；它与 pending 一样属于「可派发」，不是在途。
    // （旧逻辑把 ready 塞进 inFlight，导致视图里 ready 恒空、卡片任务显示成在途。）
    if (st !== "pending" && st !== "ready") {
      inFlight.push(task); // dispatching/running/blocked 才算在途
      continue;
    }
    const pendingDeps = (task.deps ?? []).filter((d) => statusOf(d) !== "done");
    if (pendingDeps.length === 0) {
      ready.push(task);
    } else {
      waiting.push({ task, pendingDeps }); // 「在等谁」的直接证据
    }
  }
  return { ready, waiting, inFlight, done };
}

/**
 * 从就绪集取本批：按图内声明序取前 limit 个（S1 limit=1）。
 * 确定性排序：同一批图两次计算结果一致，对账可重放。
 */
export function selectBatch(ready: Task[], { limit = 1 }: { limit?: number } = {}): Task[] {
  return ready.slice(0, limit);
}

/** 宽泛声明：含通配或目录尾斜杠——描述的是「域」，不是某个具体文件 */
function isBroadScope(scope: string): boolean {
  return scope.includes("*") || scope.endsWith("/");
}

/**
 * 写域重叠（S2 #15）：前缀相交即冲突，但**相同的宽泛声明视为共享域**。
 *
 * 为什么：`writeScopes` 是粗粒度声明，几乎每个任务都会带 `test/**` 这种「我也会动测试」。
 * 若把它当成互斥锁，全图永远串行——实测 11 个任务、3 个无依赖，批次恒为 1。
 * 两个任务同时往 `test/` 下**新增不同文件**并不冲突，真正危险的是同一文件或包含关系：
 *   - 完全相同且是具体路径（无通配、无尾斜杠）→ 同一文件，互斥；
 *   - 一个是另一个的严格前缀（`src/api/` 与 `src/api/user.ts`）→ 包含，互斥；
 *   - 相同宽泛声明（`test/` 与 `test/`）→ 共享域，放行并行。
 */
function overlaps(a: string, b: string): boolean {
  if (a === b) return !isBroadScope(a);
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * 写域裁决（S2 #15）：从就绪集贪心挑批——按图声明序，写域与已选批次重叠的跳过（先到者放行），
 * 并发槽 = concurrency - 在途数。
 * @returns { batch, conflicts: 因写域重叠被跳过的任务 }
 */
export function arbitrate(
  ready: Task[],
  { concurrency = 1, inFlightCount = 0 }: { concurrency?: number; inFlightCount?: number } = {},
): { batch: Task[]; conflicts: Task[] } {
  const slots = Math.max(0, concurrency - inFlightCount);
  const batch: Task[] = [];
  const conflicts: Task[] = [];
  for (const task of ready) {
    if (batch.length >= slots) break;
    const scopes = task.writeScopes ?? [];
    const clash = batch.some((t) => (t.writeScopes ?? []).some((a) => scopes.some((b) => overlaps(a, b))));
    if (clash) {
      conflicts.push(task); // 先到先得：本批已有人在写重叠域
      continue;
    }
    batch.push(task);
  }
  return { batch, conflicts };
}

/**
 * 死锁嗅探（S2 #17 的完整巡检在此之前先用这个原始判据）：
 * 就绪集空 + 没在途 + 图未完 = 死锁。
 */
export function isDeadlocked({ ready, waiting, inFlight }: Pick<ReadyInfo, "ready" | "waiting" | "inFlight">): boolean {
  return ready.length === 0 && inFlight.length === 0 && waiting.length > 0;
}

/** 图完成判定：全部 done */
export function isComplete(graph: Graph, statusMap: StatusMap = {}): boolean {
  return graph.tasks.every((t) => (statusMap[t.id]?.status ?? "pending") === "done");
}

/**
 * 可派发集合（计划卡哈希的唯一口径，gate.offer 与 confirm 两端必须一致）：
 * 前驱全 done 且状态 ∈ {pending, ready}——pending 是未物化，ready 是已物化，同一批。
 */
export function dispatchableTasks(graph: Graph, statusMap: StatusMap = {}): Task[] {
  const statusOf = (id: string) => statusMap[id]?.status ?? "pending";
  return graph.tasks.filter((t) => {
    const st = statusOf(t.id);
    if (st !== "pending" && st !== "ready") return false;
    return (t.deps ?? []).every((d) => statusOf(d) === "done");
  });
}
