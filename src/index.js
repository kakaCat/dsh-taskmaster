// dsh-taskmaster 插件入口（S1 施工中）。
// 当前完成：persister（工作项 #1）——原子写 / 单写者锁 / 事件流 / 投影 CAS。
// 待续：graph-store(#2) → binder(#3) → scheduler(#4) → gate(#5) → deliverer(#6) → …
// 施工序与出口判据见 docs/projects/PRJ-0002/plan/taskmaster-plan.md。

export { atomicWriteFileSync } from "./persister/atomic-write.js";
export { SingleWriterLock, LockHeldError } from "./persister/lock.js";
export { EventLog } from "./persister/event-log.js";
export { readProjection, casWriteProjection, WriteConflictError } from "./persister/projection-store.js";
