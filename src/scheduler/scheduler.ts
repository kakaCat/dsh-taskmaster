import type { Graph, Task, StatusMap } from "../types.ts";

// 就绪计算（FR-2）：任何派发路径共享的唯一入口。
// 纪律：只有「全部前驱 done」的任务能进就绪集——无论触发来自工具、心跳对账还是重启续调。
// S1 并发固定 1（串行派发）；写域裁决是 S2（#15），此处只算依赖、不管写域。

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
    if (st !== "pending") {
      inFlight.push(task); // ready/planned/dispatching/running/blocked 都算在途
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
