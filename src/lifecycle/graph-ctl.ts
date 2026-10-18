// 图级反向控制（FR-11/12/13，IF-5 的人裁入口）：暂停/恢复/停止/注销。
// 纪律：
//   - 全部人发起（引擎内部没有到这些动作的边）；actor 落事件留痕；
//   - 注销二次确认（confirm-required）；不可逆（deregistered 无任何出边）；
//   - 注销时在途绑定按失联处置：关闭 + 逐条上报（推荐路径是先停止再注销，但不强制）；
//   - 除名不删史：图版本/事件流/runs/ 全部保留可查。

import { join } from "node:path";
import { atomicWriteFileSync } from "../persister/atomic-write.ts";
import { EventLog } from "../persister/event-log.ts";

export class ConfirmRequiredError extends Error {
  code: string;
  constructor(action, graphId) {
    super(`confirm required: ${action} ${graphId}（不可逆操作需二次确认）`);
    this.code = "confirm-required";
  }
}

export class GraphCtl {
  dataRoot: string;
  store: any;
  binder: any;
  constructor(dataRoot, { store, binder }: any) {
    this.dataRoot = dataRoot;
    this.store = store;
    this.binder = binder;
  }

  #eventLog(graphId) {
    return EventLog.open(join(this.dataRoot, "events", `${graphId}.events.ndjson`));
  }

  /** 暂停（FR-11）：不派新，在途照跑照验收照探活 */
  pause(graphId, { actor }) {
    return this.store.setLifecycle(graphId, "paused", { actor });
  }

  /** 恢复（FR-11） */
  resume(graphId, { actor }) {
    return this.store.setLifecycle(graphId, "active", { actor });
  }

  /** 停止（FR-12）：不派新 + 在途转待处置；reconciler 清点收口后转 stopped */
  stop(graphId, { actor }) {
    return this.store.setLifecycle(graphId, "stopping", { actor });
  }

  /**
   * 注销（FR-19→FR-13）：移出活跃集，不可逆。
   * 在途绑定按失联处置：逐条关闭 + 上报人裁；历史全留。
   */
  deregister(graphId: any, { actor, confirm }: any = {}, now: any = new Date()) {
    if (confirm !== true) throw new ConfirmRequiredError("deregister", graphId);
    // 在途绑定失联处置
    const orphans = this.binder.byGraph(graphId);
    const events = this.#eventLog(graphId);
    for (const b of orphans) {
      this.binder.close(b.taskId, { outcome: "deregistered-lost-contact" });
      events.append("binding-abandoned", { taskId: b.taskId, runId: b.runId, sessionId: b.sessionId });
      atomicWriteFileSync(
        join(this.dataRoot, "reports", `${now.toISOString().replaceAll(":", "-")}-abandoned-${b.taskId}.json`),
        JSON.stringify(
          { kind: "abandoned", graphId, taskId: b.taskId, runId: b.runId, sessionId: b.sessionId, at: now.toISOString() },
          null,
          2,
        ),
      );
    }
    const r = this.store.setLifecycle(graphId, "deregistered", { actor });
    return { ...r, abandoned: orphans.map((b) => b.taskId) };
  }
}
