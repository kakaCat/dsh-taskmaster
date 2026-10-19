// binder 单元测试（S1 工作项 #3，覆盖 FR-14 / AC-14.1/14.2）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Binder, BindingConflictError, StaleRunError } from "../src/binder/binder.ts";

function scratch() {
  return mkdtempSync(join(tmpdir(), "tm-binder-"));
}

const spec = { graphId: "g-1", graphVersion: 1, taskId: "t-1", sessionId: "s-1", channel: "spawn" };

test("建绑定：四元组 + sessionId + runId 世代齐全并落盘", () => {
  const dir = scratch();
  const b = new Binder(dir);
  const binding = b.open(spec);
  assert.equal(binding.state, "active");
  assert.ok(binding.runId.startsWith("r-"));
  assert.equal((b.byTask("g-1", "t-1") as any).sessionId, "s-1");
  // 重开进程视角：同目录从盘上读回
  const reopened = new Binder(dir);
  assert.equal((reopened.byTask("g-1", "t-1") as any).runId, binding.runId);
});

test("不变量①：任务同时刻最多一条活跃绑定", () => {
  const b = new Binder(scratch());
  b.open(spec);
  assert.throws(() => b.open({ ...spec, sessionId: "s-2" }), (e) => e instanceof BindingConflictError && /任务已有活跃绑定/.test(e.message));
});

test("不变量②：同一 sessionId 不出现在两条活跃绑定", () => {
  const b = new Binder(scratch());
  b.open(spec);
  assert.throws(() => b.open({ ...spec, taskId: "t-2" }), (e) => e instanceof BindingConflictError && /会话已挂活跃绑定/.test(e.message));
});

test("检索键是 (graphId, taskId)：跨图同名任务互不阻塞、互不串账（回归）", () => {
  const b = new Binder(scratch());
  const a = b.open(spec); // g-1/t-1
  // 另一张图的同名任务：不触发不变量①，各自持有活跃绑定
  const c = b.open({ ...spec, graphId: "g-2", sessionId: "s-2" });
  assert.notEqual(a.runId, c.runId);
  // 关 g-1 的账不影响 g-2
  b.close("g-1", "t-1", { outcome: "done" });
  assert.equal(b.byTask("g-1", "t-1"), null);
  assert.equal(b.byTask("g-2", "t-1")!.runId, c.runId);
  // g-1 的旧世代拒收不波及 g-2 的当前世代
  assert.throws(() => b.assertCurrent("g-1", "t-1", a.runId), (e) => e instanceof BindingConflictError);
  assert.equal(b.assertCurrent("g-2", "t-1", c.runId).runId, c.runId);
});

test("AC-14.2：人裁重派签发新世代，旧世代回话 stale-run 拒收", () => {
  const b = new Binder(scratch());
  const old = b.open(spec);
  b.supersede("g-1", "t-1", { reason: "resume" });
  const fresh = b.open(spec);
  assert.notEqual(fresh.runId, old.runId);
  // 旧世代交卷 → 拒收
  assert.throws(() => b.assertCurrent("g-1", "t-1", old.runId), (e) => e instanceof StaleRunError && e.code === "stale-run");
  // 新世代 → 通过
  assert.equal(b.assertCurrent("g-1", "t-1", fresh.runId).runId, fresh.runId);
});

test("终态关绑定：台账清空、任务可再派", () => {
  const b = new Binder(scratch());
  b.open(spec);
  const closed = b.close("g-1", "t-1", { outcome: "done" });
  assert.equal((closed as any).state, "closed");
  assert.equal(b.byTask("g-1", "t-1"), null);
  assert.equal(b.active().length, 0);
  // 关绑定后同一任务/同一会话都可再绑
  const again = b.open({ ...spec });
  assert.ok(again.runId);
});

test("持久化：bindings.json 可跨实例读回；损坏时从空台账起步（Boot 重放重建）", () => {
  const dir = scratch();
  const b = new Binder(dir);
  b.open(spec);
  const reopened = new Binder(dir);
  assert.equal(reopened.byTask("g-1", "t-1")!.sessionId, "s-1");
  // 损坏：写入坏 JSON → 不炸，从空起步
  writeFileSync(join(dir, "bindings.json"), "{oops");
  const degraded = new Binder(dir);
  assert.equal(degraded.active().length, 0);
});

test("寻址查询面：byTask / bySession / byGraph", () => {
  const b = new Binder(scratch());
  b.open(spec);
  b.open({ ...spec, taskId: "t-2", sessionId: "s-2" });
  b.open({ ...spec, graphId: "g-2", taskId: "t-9", sessionId: "s-9" });
  assert.equal(b.bySession("s-2")!.taskId, "t-2");
  assert.equal(b.byGraph("g-1").length, 2);
  assert.equal(b.byGraph("g-2").length, 1);
});

test("探活游标：touchEventSeq 只进不退", () => {
  const b = new Binder(scratch());
  b.open(spec);
  b.touchEventSeq("g-1", "t-1", 5);
  b.touchEventSeq("g-1", "t-1", 3); // 回退忽略
  assert.equal((b.byTask("g-1", "t-1") as any).lastEventSeq, 5);
});
