// dsh-taskmaster 插件入口。
// 已完成：引擎内核 + 宿主集成（cordis 插件/通道/适配器）+ 真宿主联调上线。
// 插件装载协议（cordis patch 按包名加载，需要规范导出：apply / inject / name / Config）
export { apply, inject, name, Config } from "./host/plugin.ts";
// 施工序与出口判据见 docs/projects/PRJ-0002/plan/taskmaster-plan.md。

export { atomicWriteFileSync } from "./persister/atomic-write.ts";
export { SingleWriterLock, LockHeldError } from "./persister/lock.ts";
export { EventLog } from "./persister/event-log.ts";
export { readProjection, casWriteProjection, WriteConflictError } from "./persister/projection-store.ts";
export { GraphStore, GraphNotFoundError, BadTransitionError, LIFECYCLE_TRANSITIONS } from "./graph-store/graph-store.ts";
export { validateGraph, assertValidGraph, GraphValidationError } from "./graph-store/validate.ts";
export { Binder, BindingConflictError, StaleRunError } from "./binder/binder.ts";
export { computeReady, selectBatch, isDeadlocked, isComplete, dispatchableTasks } from "./scheduler/scheduler.ts";
export { Gate, PlanStaleError, PlanNotPendingError, readyHashOf, writeScopeConflicts } from "./gate/gate.ts";
export { Deliverer, DeliveryFailedError, DeliveryConflictError, assemblePackage, CHANNEL_ORDER } from "./deliverer/deliverer.ts";
export { Acceptor, EvidenceInsufficientError, NotRunningError } from "./acceptor/acceptor.ts";
export { Monitor } from "./monitor/monitor.ts";
export { Reconciler } from "./reconciler/reconciler.ts";
export { GraphCtl, ConfirmRequiredError } from "./lifecycle/graph-ctl.ts";
export { boot, BootRefusedError } from "./engine/boot.ts";
export { loadConfig, DEFAULT_CONFIG } from "./engine/config.ts";
export { rebuildProjection } from "./engine/rebuild.ts";
export { EngineGuard } from "./engine/guard.ts";
export { Statuser, computeWaves } from "./statuser/statuser.ts";
export { TaskmasterTools } from "./tools/tools.ts";
