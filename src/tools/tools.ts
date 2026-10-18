// tm_* 工具面（IF-1~IF-7 装配）：人/agent 的唯一入口，引擎内部路径不经此。
// 纪律：工具永不抛异常——错误统一包成 { ok:false, code, message, issues? }；
// 人裁动作（taskAction）记录 actor；confirm 的哈希用当前就绪集现算（plan-stale 判定）。
// 输出契约（真宿主 dsh-tools）：返回对象必须是 lossless JSON——**不能带 value=undefined 的字段**
// （宿主 snapshotJsonValue 会把 {issues:undefined} 判为 non-lossless 并整条替换成
// "tool returned invalid output"，错误码对模型不可见）。因此可选字段只在有值时挂上。

import * as yaml from "js-yaml";
import { join } from "node:path";
import { readProjection, casWriteProjection } from "../persister/projection-store.ts";
import { dispatchableTasks } from "../scheduler/scheduler.ts";
import { readyHashOf } from "../gate/gate.ts";
import { Statuser } from "../statuser/statuser.ts";
import { EventLog } from "../persister/event-log.ts";

/** 人裁动作 → 目标状态（reopen 回 pending 重干；resume/reassign 回 ready 重派新世代） */
const TASK_ACTIONS = {
  resume: { toStatus: "ready", closeBinding: true },
  reassign: { toStatus: "ready", closeBinding: true },
  reopen: { toStatus: "pending", closeBinding: true },
};

function codedError(code: string, message: string): Error {
  const e: any = new Error(message);
  e.code = code;
  return e;
}

/** 把错误拍平成 lossless JSON：可选字段（issues/missing）只在有值时出现 */
function errorResult(e: any) {
  const out: any = {
    ok: false,
    code: e?.code ?? "internal",
    message: String(e?.message ?? e),
  };
  if (e?.issues !== undefined) out.issues = e.issues;
  if (e?.missing !== undefined) out.missing = e.missing;
  return out;
}

export class TaskmasterTools {
  e: any;
  /** @param engine boot() 的返回（disabled 时也带 store/binder/gate/ctl/acceptor——读写照常） */
  constructor(engine) {
    this.e = engine;
  }

  #wrap(fn) {
    return (args) => fn(args).catch((e) => errorResult(e));
  }

  /** 属主校验（NFR-4 / IF-6）：图的属主窗口之外的人裁动作一律拒绝；owner 为空的历史图放行 */
  #assertOwner(graphId: string, actor: string | null | undefined): any {
    const meta = this.e.store.meta(graphId); // 不存在 → graph-not-found
    const owner: string | null = meta.ownerSessionId ?? null;
    if (owner && actor !== owner) {
      throw codedError("authority-required", `图 ${graphId} 属主是 ${owner}，拒绝 ${actor ?? "(unknown)"} 的人裁动作`);
    }
    return meta;
  }

  /** IF-1 注册/改图（读写照常，不受开关管辖）；ownerSessionId = 属主窗口（NFR-4） */
  upsertGraph = this.#wrap(async ({ graphYaml, graphId, ownerSessionId }) => {
    if (graphId !== undefined) {
      const meta = this.#assertOwner(graphId, ownerSessionId ?? null);
      // 注销是终态（除名留史）：允许再堆版本只会产生永不派发的死数据
      if (meta.lifecycle === "deregistered") {
        throw codedError("bad-transition", `图 ${graphId} 已注销（终态），不可再改；如需重来请新建图`);
      }
    }
    const graph = typeof graphYaml === "string" ? yaml.load(graphYaml) : graphYaml;
    const r = this.e.store.upsert(graph, { graphId, ownerSessionId });
    return { ok: true, ...r };
  });

  /** IF-2 确认/驳回计划卡 */
  confirmPlan = this.#wrap(async ({ graphId, planId, reject = false, reason, actor }) => {
    this.#assertOwner(graphId, actor ?? null);
    const meta = this.e.store.meta(graphId);
    const statusMap = readProjection(join(this.e.store.dataRoot, "state", `${graphId}.state.json`)).data ?? {};
    // 与 gate.offer 同一口径：可派发集合（pending+ready 且前驱全 done）
    const readyIds = dispatchableTasks(this.e.store.get(graphId), statusMap).map((t) => t.id);
    const card = this.e.gate.current(graphId);
    const hashNow = readyHashOf({
      graphVersion: meta.activeVersion,
      readyIds,
      batchIds: (card?.batch ?? []).map((b) => b.taskId),
      concurrency: card?.concurrency ?? 1,
    });
    if (reject) {
      const card2 = this.e.gate.reject(graphId, planId, { reason });
      this.#event(graphId, "plan-rejected-by", { planId, actor: actor ?? null });
      return { ok: true, rejected: true, planId: card2.planId };
    }
    const batch = this.e.gate.confirm(graphId, planId, hashNow);
    return { ok: true, confirmed: true, batch };
  });

  /** IF-3 交卷 / 报 blocked（执行者回向；不按属主校验——执行者不是属主） */
  nodeUpdate = this.#wrap(async ({ graphId, taskId, runId, evidence, blocked = false, reason }) => {
    const binding = this.e.binder.byTask(taskId);
    const graphVersion = binding?.graphVersion ?? this.e.store.meta(graphId).activeVersion;
    const graph = this.e.store.get(graphId, graphVersion); // 按派发时快照验收
    if (blocked) {
      const r = await this.e.acceptor.reportBlocked({ graphId, taskId, runId, reason });
      return { ok: true, ...r };
    }
    const r = await this.e.acceptor.submit({ graphId, graph, taskId, runId, evidence });
    return { ok: true, ...r };
  });

  /** IF-4 量化视图（只读；图不存在 → 空结果 + notice，不失败） */
  status = this.#wrap(async ({ graphId, groupBy, taskId }) => {
    const st = new Statuser(this.e.store.dataRoot, { store: this.e.store, binder: this.e.binder, gate: this.e.gate });
    let view: any;
    try {
      view = st.status({ graphId, groupBy, taskId });
    } catch (e: any) {
      if (e?.code !== "graph-not-found") throw e;
      view = { graphId, notice: `图 ${graphId} 不存在（或已注销到不可读）` };
    }
    view.engine = this.#engineState();
    return { ok: true, view };
  });

  /** IF-7 引擎级停止/启动（S2）：运行态开关；start 同时清降级标记 */
  engineCtl = this.#wrap(async ({ action, actor }: any = {}) => {
    const guard = this.e.guard;
    if (!guard) return { ok: false, code: "no-engine", message: "引擎未启用（enabled=false）" };
    if (action === "stop") {
      guard.stop();
      this.e.heartbeat?.stop?.();
      return {
        ok: true,
        stopped: true,
        note: "心跳已停：零派发零探活；在途不杀、台账保留；tm_engine_start 或重启恢复",
      };
    }
    if (action === "start") {
      guard.start();
      guard.clearDegraded(); // 人主动恢复 = 允许重新尝试派发（否则降级不可逆，只能重启）
      this.e.heartbeat?.start?.();
      return {
        ok: true,
        stopped: false,
        note: "恢复：心跳重启、降级标记已清；在途绑定由下一拍探活接管",
      };
    }
    return { ok: false, code: "bad-action", message: `未知动作 ${action}（可选 stop/start）` };
  });

  /** IF-5 图级反向控制（人裁：暂停/恢复/停止/注销） */
  graphCtl = this.#wrap(async ({ graphId, action, confirm, actor }) => {
    const fn = { pause: "pause", resume: "resume", stop: "stop", deregister: "deregister" }[action];
    if (!fn) return { ok: false, code: "bad-action", message: `未知动作 ${action}（可选 pause/resume/stop/deregister）` };
    this.#assertOwner(graphId, actor ?? null);
    const r = this.e.ctl[fn](graphId, { actor: actor ?? "unknown", confirm });
    return { ok: true, ...r };
  });

  /**
   * IF-6 任务级人裁（resume/reassign/reopen）：签发新世代、旧绑定关闭、任务回 ready/pending，
   * 重派走标准链（下一拍出卡 → 确认 → 投递）。引擎自身调不到这里。
   */
  taskAction = this.#wrap(async ({ graphId, taskId, action, reason, actor }) => {
    const rule = TASK_ACTIONS[action];
    if (!rule) return { ok: false, code: "bad-action", message: `未知人裁动作 ${action}（可选 resume/reassign/reopen）` };
    this.#assertOwner(graphId, actor ?? null);
    const statePath = join(this.e.store.dataRoot, "state", `${graphId}.state.json`);
    const proj = readProjection(statePath);
    const status = proj.data?.[taskId]?.status ?? "pending";
    // 状态合法性：resume/reassign 对在途（running/blocked）；reopen 对 done
    const legal = action === "reopen" ? status === "done" : status === "running" || status === "blocked";
    if (!legal) {
      const e = new Error(`bad-state: ${action} 不允许作用于 status=${status}`);
      (e as any).code = "bad-state";
      throw e;
    }
    if (rule.closeBinding) this.e.binder.supersede(taskId, { reason: `${action} by ${actor ?? "unknown"}: ${reason ?? ""}` });
    casWriteProjection(statePath, proj.version, {
      ...proj.data,
      [taskId]: { ...proj.data[taskId], status: rule.toStatus, runId: null },
    });
    this.#event(graphId, `task-${action}`, { taskId, actor: actor ?? null, reason: reason ?? null });
    return { ok: true, action, taskId, status: rule.toStatus, note: "下一拍出卡重派，新世代 runId 签发" };
  });

  /** 引擎运行态（degraded 是派发静默的根因，必须在视图里可见） */
  #engineState() {
    const guard = this.e.guard;
    if (!guard) return { enabled: false, degraded: false, degradedReason: null, stopped: true, heartbeat: false };
    return {
      enabled: guard.enabled,
      degraded: !!guard.degraded,
      degradedReason: guard.degradedReason ?? null,
      stopped: !!guard.stopped,
      heartbeat: !!this.e.heartbeat?.running?.(),
    };
  }

  #event(graphId, kind, fields) {
    EventLog.open(join(this.e.store.dataRoot, "events", `${graphId}.events.ndjson`)).append(kind, fields);
  }
}
