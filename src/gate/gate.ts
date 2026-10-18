// 确认闸（FR-4 / IF-2）：计划卡是派发前唯一的门。
// 纪律：
//   - 不带 confirm 永不派发（闸的下游只信 confirm 返回的批次）；
//   - 计划卡幂等更新：同一批就绪重复出卡只更新、不刷屏；
//   - 卡带图版本 + 就绪集哈希：就绪集变了，旧卡 confirm = plan-stale；
//   - 驳回不消失：任务保持 ready，驳回的哈希记住，同批不重复出卡；
//   - gate=auto 切面：整批任务都在 auto 里程碑内 → 免确认（自动确认）。

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../persister/atomic-write.ts";
import { EventLog } from "../persister/event-log.ts";
import type { PlanCard, Task } from "../types.ts";

export class PlanStaleError extends Error {
  code: string;
  constructor(planId) {
    super(`plan stale: ${planId}（就绪集已变化，需重新出卡）`);
    this.code = "plan-stale";
  }
}

export class PlanNotPendingError extends Error {
  code: string;
  constructor(planId, state) {
    super(`plan not pending: ${planId} (state=${state})`);
    this.code = "plan-not-pending";
  }
}

/** 就绪集哈希：图版本 + 就绪任务集 + 本批 + 并发上限——任一变化旧卡即失效 */
export function readyHashOf({ graphVersion, readyIds, batchIds, concurrency }: { graphVersion: number; readyIds: string[]; batchIds: string[]; concurrency: number }): string {
  const payload = JSON.stringify({
    v: graphVersion,
    ready: [...readyIds].sort(),
    batch: [...batchIds].sort(),
    c: concurrency,
  });
  return createHash("sha1").update(payload).digest("hex").slice(0, 12);
}

/** 写域冲突检测（S1 只展示不裁决）：前缀相交即冲突 */
export function writeScopeConflicts(readyTasks: Task[]): Array<{ tasks: string[]; scopes: string[] }> {
  const conflicts: any[] = [];
  const overlap = (a, b) => a.startsWith(b) || b.startsWith(a);
  for (let i = 0; i < readyTasks.length; i++) {
    for (let j = i + 1; j < readyTasks.length; j++) {
      const A = readyTasks[i];
      const B = readyTasks[j];
      const shared = (A.writeScopes ?? []).filter((sa) => (B.writeScopes ?? []).some((sb) => overlap(sa, sb)));
      if (shared.length > 0) conflicts.push({ tasks: [A.id, B.id], scopes: shared });
    }
  }
  return conflicts;
}

export class Gate {
  dataRoot: string;
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
  }

  #planPath(graphId) {
    return join(this.dataRoot, "plans", `${graphId}.json`);
  }

  #load(graphId) {
    const p = this.#planPath(graphId);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  }

  #save(record) {
    atomicWriteFileSync(this.#planPath(record.graphId), JSON.stringify(record, null, 2));
  }

  #eventLog(graphId) {
    return EventLog.open(join(this.dataRoot, "events", `${graphId}.events.ndjson`));
  }

  /** 当前计划卡（含 rejected/superseded 态，供视图查询） */
  current(graphId: string): PlanCard | null {
    return this.#load(graphId)?.card ?? null;
  }

  /**
   * 出/更新计划卡。
   * @param batch 本批（S1 = 1 个任务）
   * @param ready 全部就绪任务（卡上展示冲突用）
   * @returns {{ card, isNew, autoConfirmed }}
   */
  offer({ graphId, graphVersion, ready, batch, concurrency = 1, autoFacets = [], conflicts }: { graphId: string; graphVersion: number; ready: Task[]; batch: Task[]; concurrency?: number; autoFacets?: string[]; conflicts?: Task[] }, now: Date = new Date()) {
    const hash = readyHashOf({
      graphVersion,
      readyIds: ready.map((t) => t.id),
      batchIds: batch.map((t) => t.id),
      concurrency,
    });
    const record = this.#load(graphId);

    // 幂等：pending 卡哈希相同 → 原样返回（不刷屏、不算新卡）
    if (record?.card?.state === "pending" && record.card.readyHash === hash) {
      return { card: record.card, isNew: false, autoConfirmed: false };
    }
    // 驳回记忆：同批刚被驳回，不重复出卡（等人改图或就绪集变化）
    if (record?.rejectedHash === hash) {
      return { card: record.card, isNew: false, autoConfirmed: false, suppressedByReject: true };
    }

    // 旧 pending 卡被顶替
    const superseded: any[] = [...(record?.superseded ?? [])];
    if (record?.card?.state === "pending") {
      superseded.push(record.card.planId);
      if (superseded.length > 10) superseded.shift(); // 有界，只用于区分 stale 与 missing
      this.#eventLog(graphId).append("plan-superseded", { planId: record.card.planId });
    }

    const card: PlanCard = {
      planId: `p-${Date.now().toString(36)}-${createHash("sha1").update(hash).digest("hex").slice(2, 8)}`,
      graphId,
      graphVersion,
      readyHash: hash,
      batch: batch.map((t) => ({ taskId: t.id, statement: t.statement })),
      readyCount: ready.length,
      conflicts:
        conflicts && conflicts.length > 0
          ? conflicts.map((t) => ({ tasks: [t.id], scopes: t.writeScopes ?? [] }))
          : writeScopeConflicts(ready),
      concurrency,
      state: "pending",
      createdAt: now.toISOString(),
    };

    // gate=auto 切面：整批都在 auto 里程碑内 → 免确认
    const auto = batch.length > 0 && batch.every((t) => autoFacets.includes(t.milestone ?? ""));
    if (auto) {
      card.state = "confirmed";
      card.confirmedAt = now.toISOString();
      card.autoConfirmed = true;
      this.#eventLog(graphId).append("plan-confirmed", { planId: card.planId, auto: true, batch: card.batch.map((b) => b.taskId) });
    } else {
      this.#eventLog(graphId).append("plan-offered", { planId: card.planId, batch: card.batch.map((b) => b.taskId) });
    }

    this.#save({ graphId, card, rejectedHash: record?.rejectedHash ?? null, superseded });
    return { card, isNew: true, autoConfirmed: auto };
  }

  /** 判卡归属：当前卡 / 被顶替的（stale）/ 没见过的（missing） */
  #expectCard(record, planId) {
    const card = record?.card;
    if (card && card.planId === planId) return card;
    if (record?.superseded?.includes(planId)) throw new PlanStaleError(planId);
    throw new PlanNotPendingError(planId, card ? card.state : "missing");
  }

  /**
   * 确认计划卡（IF-2）。校验卡状态 + 就绪集哈希未漂移。
   * @param readyHashNow 调用方用当前就绪集现算的哈希
   * @returns 获准派发的批次
   */
  confirm(graphId, planId, readyHashNow, now = new Date()) {
    const record = this.#load(graphId);
    const card = this.#expectCard(record, planId);
    if (card.state !== "pending") throw new PlanNotPendingError(planId, card.state);
    if (card.readyHash !== readyHashNow) throw new PlanStaleError(planId);
    card.state = "confirmed";
    card.confirmedAt = now.toISOString();
    this.#eventLog(graphId).append("plan-confirmed", { planId, batch: card.batch.map((b) => b.taskId) });
    this.#save(record);
    return card.batch;
  }

  /** 驳回：任务保持 ready；记住驳回哈希，同批不再自动出卡 */
  reject(graphId: string, planId: string, { reason }: { reason?: string } = {}, now: Date = new Date()) {
    const record = this.#load(graphId);
    const card = this.#expectCard(record, planId);
    if (card.state !== "pending") throw new PlanNotPendingError(planId, card.state);
    card.state = "rejected";
    card.rejectedAt = now.toISOString();
    card.rejectReason = reason ?? null;
    this.#eventLog(graphId).append("plan-rejected", { planId, reason: reason ?? null });
    this.#save({ graphId, card, rejectedHash: card.readyHash, superseded: record.superseded ?? [] });
    return card;
  }
}
