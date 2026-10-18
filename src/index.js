// dsh-taskmaster 插件入口（S1 施工中）。
// 已完成：#1~#10 + #11 Boot（五步自举/崩溃重建/在途重挂）。
// 待续：statuser(#12) → 开关降级(#13) → tm_* 工具面(#14)。
// 施工序与出口判据见 docs/projects/PRJ-0002/plan/taskmaster-plan.md。

export { atomicWriteFileSync } from "./persister/atomic-write.js";
export { SingleWriterLock, LockHeldError } from "./persister/lock.js";
export { EventLog } from "./persister/event-log.js";
export { readProjection, casWriteProjection, WriteConflictError } from "./persister/projection-store.js";
export { GraphStore, GraphNotFoundError, BadTransitionError, LIFECYCLE_TRANSITIONS } from "./graph-store/graph-store.js";
export { validateGraph, assertValidGraph, GraphValidationError } from "./graph-store/validate.js";
export { Binder, BindingConflictError, StaleRunError } from "./binder/binder.js";
export { computeReady, selectBatch, isDeadlocked, isComplete } from "./scheduler/scheduler.js";
export { Gate, PlanStaleError, PlanNotPendingError, readyHashOf, writeScopeConflicts } from "./gate/gate.js";
export { Deliverer, DeliveryFailedError, DeliveryConflictError, assemblePackage, CHANNEL_ORDER } from "./deliverer/deliverer.js";
export { Acceptor, EvidenceInsufficientError, NotRunningError } from "./acceptor/acceptor.js";
export { Monitor } from "./monitor/monitor.js";
export { Reconciler } from "./reconciler/reconciler.js";
export { GraphCtl, ConfirmRequiredError } from "./lifecycle/graph-ctl.js";
export { boot, BootRefusedError } from "./engine/boot.js";
export { loadConfig, DEFAULT_CONFIG } from "./engine/config.js";
export { rebuildProjection } from "./engine/rebuild.js";
