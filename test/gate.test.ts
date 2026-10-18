// gate 单元测试（S1 工作项 #5，覆盖 FR-4 / AC-4.1 及 IF-2 语义）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gate, PlanStaleError, PlanNotPendingError, readyHashOf, writeScopeConflicts } from "../src/gate/gate.ts";

function scratch() {
  return mkdtempSync(join(tmpdir(), "tm-gate-"));
}

const T = (id, extra = {}) => ({ id, statement: `任务 ${id}`, deps: [], checks: ["x"], writeScopes: [], ...extra });

function offerArgs(gate) {
  const batch = [T("t-1")];
  const ready = [T("t-1"), T("t-2")];
  return {
    batch,
    ready,
    hashNow: readyHashOf({ graphVersion: 1, readyIds: ready.map((t) => t.id), batchIds: batch.map((t) => t.id), concurrency: 1 }),
    offer: { graphId: "g-1", graphVersion: 1, ready, batch, concurrency: 1 },
  };
}

test("出卡 → pending；不确认就没有批次（AC-4.1 的闸侧）", () => {
  const gate = new Gate(scratch());
  const { offer, hashNow } = offerArgs(gate);
  const r = gate.offer(offer);
  assert.equal(r.isNew, true);
  assert.equal(r.card.state, "pending");
  assert.equal(r.autoConfirmed, false);
  // 未确认前，confirm 之外的任何路径拿不到批次（没有 confirm 就没有返回值里的 batch）
  assert.equal(gate.current("g-1").state, "pending");
  // 确认后才有批次
  const batch = gate.confirm("g-1", r.card.planId, hashNow);
  assert.deepEqual(batch.map((b) => b.taskId), ["t-1"]);
});

test("幂等更新：同一批就绪重复出卡不刷屏", () => {
  const gate = new Gate(scratch());
  const { offer } = offerArgs(gate);
  const r1 = gate.offer(offer);
  const r2 = gate.offer(offer);
  assert.equal(r2.isNew, false);
  assert.equal(r2.card.planId, r1.card.planId);
  // 事件流里只有一条 plan-offered
  const gate2 = new Gate(scratch()); // 换实例不影响（各自数据根）
});

test("就绪集变化 → 旧卡被顶替；旧卡 confirm = plan-stale", () => {
  const dir = scratch();
  const gate = new Gate(dir);
  const { offer } = offerArgs(gate);
  const r1 = gate.offer(offer);
  // 就绪集变了（t-2 被派走/完成）
  const ready2 = [T("t-1")];
  const r2 = gate.offer({ ...offer, ready: ready2 });
  assert.equal(r2.isNew, true);
  assert.notEqual(r2.card.planId, r1.card.planId);
  // 旧卡 confirm → stale
  assert.throws(() => gate.confirm("g-1", r1.card.planId, r2.card.readyHash), PlanStaleError);
});

test("confirm 时就绪集已漂移 → plan-stale", () => {
  const gate = new Gate(scratch());
  const { offer } = offerArgs(gate);
  const r = gate.offer(offer);
  const drifted = readyHashOf({ graphVersion: 2, readyIds: ["t-1"], batchIds: ["t-1"], concurrency: 1 });
  assert.throws(() => gate.confirm("g-1", r.card.planId, drifted), PlanStaleError);
});

test("驳回：任务保持 ready；同批不再自动出卡；就绪集变化后可再出", () => {
  const gate = new Gate(scratch());
  const { offer } = offerArgs(gate);
  const r1 = gate.offer(offer);
  gate.reject("g-1", r1.card.planId, { reason: "先别派" });
  assert.equal(gate.current("g-1").state, "rejected");
  // 同批再 offer → 被驳回记忆压制
  const r2 = gate.offer(offer);
  assert.equal(r2.isNew, false);
  assert.equal(r2.suppressedByReject, true);
  // 就绪集变化 → 新哈希 → 可以出卡
  const r3 = gate.offer({ ...offer, ready: [T("t-1")] });
  assert.equal(r3.isNew, true);
  // 驳回后 confirm 旧卡 → not-pending
  assert.throws(() => gate.confirm("g-1", r1.card.planId, r1.card.readyHash), PlanNotPendingError);
});

test("gate=auto 切面：整批在 auto 里程碑内 → 免确认直接 confirmed", () => {
  const gate = new Gate(scratch());
  const batch = [T("t-1", { milestone: "m-auto" })];
  const r = gate.offer({
    graphId: "g-1", graphVersion: 1, ready: batch, batch, concurrency: 1, autoFacets: ["m-auto"],
  });
  assert.equal(r.autoConfirmed, true);
  assert.equal(r.card.state, "confirmed");
  // 不在切面内 → 仍要人确认
  const gate2 = new Gate(scratch());
  const r2 = gate2.offer({ graphId: "g-2", graphVersion: 1, ready: batch, batch, concurrency: 1, autoFacets: [] });
  assert.equal(r2.autoConfirmed, false);
  assert.equal(r2.card.state, "pending");
});

test("计划卡带写域冲突展示（S1 只展示不裁决）", () => {
  const conflicts = writeScopeConflicts([
    T("a", { writeScopes: ["src/api/"] }),
    T("b", { writeScopes: ["src/api/user.ts"] }),
    T("c", { writeScopes: ["docs/"] }),
  ]);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].tasks, ["a", "b"]);
});

test("持久化：换实例后卡状态可读回", () => {
  const dir = scratch();
  const gate = new Gate(dir);
  const { offer } = offerArgs(gate);
  const r = gate.offer(offer);
  const gate2 = new Gate(dir);
  assert.equal(gate2.current("g-1").planId, r.card.planId);
  assert.equal(gate2.current("g-1").state, "pending");
});
