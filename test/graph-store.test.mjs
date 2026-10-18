// graph-store 单元测试（S1 工作项 #2，覆盖 FR-1 / AC-1.1/1.2/1.3）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore, GraphNotFoundError } from "../src/graph-store/graph-store.js";
import { validateGraph, GraphValidationError } from "../src/graph-store/validate.js";

function scratch() {
  return mkdtempSync(join(tmpdir(), "tm-graph-"));
}

const validGraph = () => ({
  apiVersion: "taskmaster/v1",
  tasks: [
    { id: "t-1", statement: "建表", deps: [], checks: ["表结构落库"], writeScopes: ["db/"], roundBudget: 10 },
    { id: "t-2", statement: "写接口", deps: ["t-1"], checks: [{ text: "接口联调通过", verify: "mechanical" }], writeScopes: ["src/api/"] },
    { id: "t-3", statement: "写测试", deps: ["t-2"], checks: ["测试全绿"], writeScopes: ["test/"] },
  ],
});

test("AC-1.1：注册 3 任务图 → v1 落盘 + meta active", () => {
  const store = new GraphStore(scratch());
  const r = store.upsert(validGraph());
  assert.equal(r.version, 1);
  assert.ok(r.graphId.startsWith("g-"));
  const meta = store.meta(r.graphId);
  assert.equal(meta.activeVersion, 1);
  assert.equal(meta.lifecycle, "active");
  assert.equal(store.get(r.graphId).tasks.length, 3);
  // register 事件留痕
  const events = store.eventLog(r.graphId).readAll();
  assert.equal(events.at(-1).kind, "register");
  assert.equal(events.at(-1).tasks, 3);
});

test("AC-1.2：改图 = 新版本；旧版本可回读", () => {
  const store = new GraphStore(scratch());
  const r1 = store.upsert(validGraph());
  const modified = validGraph();
  modified.tasks[0].statement = "建表（修正版）";
  const r2 = store.upsert(modified, { graphId: r1.graphId });
  assert.equal(r2.version, 2);
  assert.deepEqual(store.listVersions(r1.graphId), [1, 2]);
  assert.equal(store.get(r1.graphId, 1).tasks[0].statement, "建表"); // 旧版本原样
  assert.equal(store.get(r1.graphId).tasks[0].statement, "建表（修正版）"); // 缺省读活跃版本
});

test("AC-1.3：有环图被拒且零落盘", () => {
  const store = new GraphStore(scratch());
  const cyclic = validGraph();
  cyclic.tasks[0].deps = ["t-3"]; // t-3 → t-2 → t-1 → t-3 成环
  assert.throws(
    () => store.upsert(cyclic),
    (e) => e instanceof GraphValidationError && e.code === "invalid-graph" && e.issues.some((i) => i.reason.includes("环")),
  );
  assert.equal(store.list().length, 0); // 零落盘
});

test("校验：悬空依赖 / 重复 id / 空陈述 / 空判据 / 坏 verify", () => {
  const g = validGraph();
  g.tasks[1].deps = ["t-99"]; // 不存在
  g.tasks.push({ ...validGraph().tasks[0] }); // 重复 id t-1
  g.tasks[2].statement = "  "; // 空陈述
  g.tasks[2].checks = []; // 空判据
  const issues = validateGraph(g);
  const reasons = issues.map((i) => i.reason).join("\n");
  assert.match(reasons, /不存在/);
  assert.match(reasons, /重复/);
  assert.match(reasons, /非空字符串/);
  assert.match(reasons, /非空数组/);

  const badVerify = validGraph();
  badVerify.tasks[0].checks = [{ text: "x", verify: "auto" }];
  assert.ok(validateGraph(badVerify).some((i) => i.target.includes("verify")));
});

test("改不存在的图 → graph-not-found；读不存在的版本 → graph-not-found", () => {
  const store = new GraphStore(scratch());
  assert.throws(() => store.upsert(validGraph(), { graphId: "g-ghost" }), GraphNotFoundError);
  const r = store.upsert(validGraph());
  assert.throws(() => store.get(r.graphId, 99), GraphNotFoundError);
});

test("多图共存：各自版本序列与事件流互不影响", () => {
  const store = new GraphStore(scratch());
  const a = store.upsert(validGraph());
  const b = store.upsert(validGraph());
  store.upsert(validGraph(), { graphId: a.graphId });
  assert.deepEqual(store.listVersions(a.graphId), [1, 2]);
  assert.deepEqual(store.listVersions(b.graphId), [1]);
  assert.equal(store.eventLog(a.graphId).readAll().length, 2);
  assert.equal(store.eventLog(b.graphId).readAll().length, 1);
});
