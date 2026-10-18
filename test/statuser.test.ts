// statuser 单元测试（S1 工作项 #12，覆盖 FR-9 / AC-9.1）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Statuser, computeWaves } from "../src/statuser/statuser.ts";
import { GraphStore } from "../src/graph-store/graph-store.ts";
import { Binder } from "../src/binder/binder.ts";
import { Gate } from "../src/gate/gate.ts";
import { readProjection, casWriteProjection } from "../src/persister/projection-store.ts";

function scratch() {
  return mkdtempSync(join(tmpdir(), "tm-status-"));
}

const graph = (): any => ({
  apiVersion: "taskmaster/v1",
  tasks: [
    { id: "t-1", statement: "建表", deps: [], checks: ["x"], kind: "db", story: "s-1", milestone: "m1" },
    { id: "t-2", statement: "接口A", deps: ["t-1"], checks: ["x"], kind: "api", story: "s-1", milestone: "m1" },
    { id: "t-3", statement: "接口B", deps: ["t-1"], checks: ["x"], kind: "api", story: "s-2", milestone: "m2" },
    { id: "t-4", statement: "测试", deps: ["t-2", "t-3"], checks: ["x"], kind: "test", story: "s-2", milestone: "m2" },
  ],
});

function setup() {
  const dir = scratch();
  const store = new GraphStore(dir);
  const binder = new Binder(dir);
  const gate = new Gate(dir);
  const { graphId } = store.upsert(graph());
  const st = new Statuser(dir, { store, binder, gate });
  return { dir, store, binder, gate, st, graphId };
}

test("AC-9.1：group_by=kind 计数与图文件一致；未就绪显示「在等谁」", () => {
  const { st, graphId } = setup();
  const v = st.status({ graphId, groupBy: "kind" });
  assert.deepEqual(v.groupBy.groups, {
    db: { total: 1, done: 0 },
    api: { total: 2, done: 0 },
    test: { total: 1, done: 0 },
  });
  // 在等谁：t-4 等 t-2/t-3；t-2 等 t-1
  const w4 = v.waiting.find((w) => w.taskId === "t-4");
  assert.deepEqual(w4.pendingDeps, ["t-2", "t-3"]);
  assert.deepEqual(v.ready, ["t-1"]);
});

test("波次：链式深度正确，汇合任务取最深前驱 +1", () => {
  const { st, graphId } = setup();
  const v = st.status({ graphId });
  assert.deepEqual(v.waves, [["t-1"], ["t-2", "t-3"], ["t-4"]]);
});

test("生命周期态如实标注（暂停/注销可见）+ 状态计数", () => {
  const { dir, store, st, graphId } = setup();
  const p = join(dir, "state", `${graphId}.state.json`);
  casWriteProjection(p, 0, { "t-1": { status: "done" } });
  store.setLifecycle(graphId, "paused", { actor: "owner" });
  const v = st.status({ graphId });
  assert.equal(v.lifecycle, "paused");
  assert.equal(v.counts.done, 1);
  assert.equal(v.counts.pending, 3); // 未物化 ready 的任务是 pending
});

test("在途详情：状态 + 活性投影 + runId（绑定台账寻址）", () => {
  const { dir, binder, st, graphId } = setup();
  const b = binder.open({ graphId, graphVersion: 1, taskId: "t-1", sessionId: "s-1", channel: "spawn" });
  binder.markLiveness("t-1", { liveness: "silent" });
  const p = join(dir, "state", `${graphId}.state.json`);
  casWriteProjection(p, 0, { "t-1": { status: "running", runId: b.runId } });
  const v = st.status({ graphId });
  assert.equal(v.inFlight[0].liveness, "silent");
  assert.equal(v.inFlight[0].runId, b.runId);
  // 单任务详情
  const d = st.status({ graphId, taskId: "t-1" });
  assert.equal(d.status, "running");
  assert.equal(d.liveness, "silent");
});

test("总览（无 graphId）：多图列出生命周期与计数；空数据根返回空", () => {
  const { st } = setup();
  const all = st.status();
  assert.equal(all.graphs.length, 1);
  assert.equal(all.graphs[0].lifecycle, "active");
  // 空数据根：所有模块同根，零图 → 空总览
  const dir2 = scratch();
  const empty = new Statuser(dir2, { store: new GraphStore(dir2), binder: new Binder(dir2), gate: new Gate(dir2) });
  assert.deepEqual(empty.status().graphs, []);
});

test("计划卡状态进视图；不存在的任务给 notice 不炸", () => {
  const { gate, st, graphId } = setup();
  const t1: any = { id: "t-1", statement: "建表", checks: ["x"], milestone: undefined };
  gate.offer({ graphId, graphVersion: 1, ready: [t1], batch: [t1], concurrency: 1 });
  const v = st.status({ graphId });
  assert.equal(v.plan.state, "pending");
  const d = st.status({ graphId, taskId: "t-99" });
  assert.ok(d.notice);
});
