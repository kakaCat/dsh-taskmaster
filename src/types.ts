// 共享领域类型（模块边界的唯一类型来源）。
// 序列化边界（YAML/JSON 读写处）允许 any，但进入引擎内部的形状必须收敛到这些接口。

export type TaskStatus = "pending" | "ready" | "dispatching" | "running" | "blocked" | "done";
export type GraphLifecycle = "active" | "paused" | "stopping" | "stopped" | "asleep" | "deregistered";
export type Liveness = "alive" | "silent" | "stalled" | "dead";

export type Check =
  | string
  | { text: string; verify?: "mechanical" | "human"; file?: string; command?: string };

/** 拆解粒度：atomic = 可直接执行；expanded = 已展开为子图（承诺由子图 outputs 兑现） */
export type TaskExpansion = "atomic" | "expanded";

/** 产出物：file = 路径、check = 可核验判据、value = 值/契约摘要 */
export type OutputKind = "file" | "check" | "value";

export interface TaskOutput {
  name: string;
  kind: OutputKind;
  path?: string;
}

export interface Task {
  id: string;
  statement: string;
  deps?: string[];
  checks: Check[];
  writeScopes?: string[];
  roundBudget?: number;
  kind?: string;
  story?: string;
  milestone?: string;
  /** 缺省语义 = atomic（旧图没有该字段，行为不变） */
  expansion?: TaskExpansion;
  /** 对外产出承诺；边（from: 节点.output）按 name 引用 */
  outputs?: TaskOutput[];
}

export interface Graph {
  apiVersion: string;
  tasks: Task[];
}

export interface GraphMeta {
  graphId: string;
  activeVersion: number;
  lifecycle: GraphLifecycle;
  ownerSessionId?: string | null;
  updatedAt?: string;
}

export interface TaskState {
  status: TaskStatus;
  runId?: string | null;
  graphVersion?: number;
  blockReason?: string | null;
  doneAt?: string;
  lastSeq?: number;
}

export type StatusMap = Record<string, TaskState>;

export interface BindingRecord {
  graphId: string;
  graphVersion: number;
  taskId: string;
  runId: string;
  sessionId: string | null;
  channel: string | null;
  state: "active" | "closed";
  dispatchedAt: string;
  startedAt: string;
  lastEventSeq: number;
  liveness?: Liveness;
  lastActivityAt?: string;
  probedAt?: string; // 本轮沉默的主动探活时刻（S2）
  closedAt?: string;
  outcome?: string | null;
}

export interface CoreConfig {
  enabled: boolean;
  beatMs: number;
  silentMs: number;
  concurrency: number;
  autoFacets: string[];
}

export interface PlanCard {
  planId: string;
  graphId: string;
  graphVersion: number;
  readyHash: string;
  batch: Array<{ taskId: string; statement: string }>;
  readyCount: number;
  conflicts: Array<{ tasks: string[]; scopes: string[] }>;
  concurrency: number;
  state: "pending" | "confirmed" | "rejected";
  createdAt: string;
  confirmedAt?: string;
  rejectedAt?: string;
  rejectReason?: string | null;
  autoConfirmed?: boolean;
}

export interface EventRecord {
  seq: number;
  ts: string;
  kind: string;
  [key: string]: unknown;
}

/** 开关无关的读写核心模块：enabled=false 时也装配，保证 tm_* 读写照常（NFR-3） */
export interface BootCore {
  config: CoreConfig;
  dataRoot: string;
  store: import("./graph-store/graph-store.ts").GraphStore;
  binder: import("./binder/binder.ts").Binder;
  gate: import("./gate/gate.ts").Gate;
  acceptor: import("./acceptor/acceptor.ts").Acceptor;
  ctl: import("./lifecycle/graph-ctl.ts").GraphCtl;
}

export interface HeartbeatControl {
  start(): void;
  stop(): void;
  running(): boolean;
}

export interface EngineModules extends BootCore {
  lock: import("./persister/lock.ts").SingleWriterLock;
  guard: import("./engine/guard.ts").EngineGuard;
  deliverer: import("./deliverer/deliverer.ts").Deliverer;
  monitor: import("./monitor/monitor.ts").Monitor;
  reconciler: import("./reconciler/reconciler.ts").Reconciler;
  heartbeat: HeartbeatControl;
  bootReport: {
    rebuilt: string[];
    reattach: { resubmitted: string[]; reattached: string[]; stalled: string[] };
  };
}

export type BootResult =
  | ({ disabled: true } & BootCore)
  | ({ disabled: false } & EngineModules);

export function isEnabledEngine(
  result: BootResult,
): result is { disabled: false } & EngineModules {
  return result.disabled === false;
}
