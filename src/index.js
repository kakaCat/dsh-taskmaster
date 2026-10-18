// dsh-taskmaster 插件入口（S1 施工中）。
// 已完成：#1 persister、#2 graph-store、#3 binder、#4 scheduler、#5 gate、#6 deliverer。
// 待续：acceptor(#7) → monitor(#8) → reconciler(#9) → …
// 施工序与出口判据见 docs/projects/PRJ-0002/plan/taskmaster-plan.md。

export { atomicWriteFileSync } from "./persister/atomic-write.js";
export { SingleWriterLock, LockHeldError } from "./persister/lock.js";
export { EventLog } from "./persister/event-log.js";
export { readProjection, casWriteProjection, WriteConflictError } from "./persister/projection-store.js";
export { GraphStore, GraphNotFoundError } from "./graph-store/graph-store.js";
export { validateGraph, assertValidGraph, GraphValidationError } from "./graph-store/validate.js";
export { Binder, BindingConflictError, StaleRunError } from "./binder/binder.js";
export { computeReady, selectBatch, isDeadlocked, isComplete } from "./scheduler/scheduler.js";
export { Gate, PlanStaleError, PlanNotPendingError, readyHashOf, writeScopeConflicts } from "./gate/gate.js";
export { Deliverer, DeliveryFailedError, DeliveryConflictError, assemblePackage, CHANNEL_ORDER } from "./deliverer/deliverer.js";
