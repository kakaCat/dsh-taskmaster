// dsh-taskmaster 插件入口（S1 施工中）。
// S1 全部 14 个工作项完成：persister/graph-store/binder/scheduler/gate/deliverer/
// acceptor/monitor/reconciler/graph-ctl/boot/statuser/guard/tools + M1 走查 e2e。
// 待续：宿主适配器（startActivation/branch/spawn 真通道 + 事件订阅）→ 宿主插件装配 → S2。
// 施工序与出口判据见 docs/projects/PRJ-0002/plan/taskmaster-plan.md。

export { atomicWriteFileSync } from "./persister/atomic-write.js";
export { SingleWriterLock, LockHeldError } from "./persister/lock.js";
export { EventLog } from "./persister/event-log.js";
export { readProjection, casWriteProjection, WriteConflictError } from "./persister/projection-store.js";
export { GraphStore, GraphNotFoundError, BadTransitionError, LIFECYCLE_TRANSITIONS } from "./graph-store/graph-store.js";
export { validateGraph, assertValidGraph, GraphValidationError } from "./graph-store/validate.js";
export { Binder, BindingConflictError, StaleRunError } from "./binder/binder.js";
export { computeReady, selectBatch, isDeadlocked, isComplete, dispatchableTasks } from "./scheduler/scheduler.js";
export { Gate, PlanStaleError, PlanNotPendingError, readyHashOf, writeScopeConflicts } from "./gate/gate.js";
export { Deliverer, DeliveryFailedError, DeliveryConflictError, assemblePackage, CHANNEL_ORDER } from "./deliverer/deliverer.js";
export { Acceptor, EvidenceInsufficientError, NotRunningError } from "./acceptor/acceptor.js";
export { Monitor } from "./monitor/monitor.js";
export { Reconciler } from "./reconciler/reconciler.js";
export { GraphCtl, ConfirmRequiredError } from "./lifecycle/graph-ctl.js";
export { boot, BootRefusedError } from "./engine/boot.js";
export { loadConfig, DEFAULT_CONFIG } from "./engine/config.js";
export { rebuildProjection } from "./engine/rebuild.js";
export { EngineGuard } from "./engine/guard.js";
export { Statuser, computeWaves } from "./statuser/statuser.js";
export { TaskmasterTools } from "./tools/tools.js";
