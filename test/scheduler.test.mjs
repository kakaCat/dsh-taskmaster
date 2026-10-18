// scheduler 单元测试（S1 工作项 #4，覆盖 FR-2 / AC-2.1）
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeReady, selectBatch, isDeadlocked, isComplete } from "../src/scheduler/scheduler.js";

// 建表 → 接口 → 测试（M1 走查脚本同款图）
const chainGraph = {
  apiVersion: "taskmaster/v1",
  tasks: [
    { id: "t-1", statement: "建表", deps: [], checks: ["x"] },
    { id: "t-2", statement: "接口", deps: ["t-1"], checks: ["x"] },
    { id: "t-3", statement: "测试", deps: ["t-2"], checks: ["x"] },
  ],
};

test("AC-2.1：前驱未 done，后继不在就绪集——任何状态下都不跳步", () => {
  // 初始：只有建表就绪
  let r = computeReady(chainGraph, {});
  assert.deepEqual(r.ready.map((t) => t.id), ["t-1"]);
  assert.deepEqual(r.waiting.map((w) => w.task.id), ["t-2", "t-3"]);

  // 建表 running：就绪集空，后继仍不可派
  r = computeReady(chainGraph, { "t-1": { status: "running" } });
  assert.equal(r.ready.length, 0);
  assert.equal(r.inFlight.length, 1);

  // 建表 done：接口就绪，测试仍在等
  r = computeReady(chainGraph, { "t-1": { status: "done" } });
  assert.deepEqual(r.ready.map((t) => t.id), ["t-2"]);

  // 被篡改状态：t-2 done 但 t-1 pending——引擎忠于声明的依赖：
  // t-3 的前驱是 t-2（已 done），所以 t-3 就绪是合法的；异常的是 t-2 的状态来历，
  // 那是验收纪律（FR-6）的管辖范围，不是就绪计算的。
  r = computeReady(chainGraph, { "t-2": { status: "done" } });
  assert.deepEqual(r.ready.map((t) => t.id), ["t-1", "t-3"]);
  // 真正的跳步检验：前驱 pending 时后继绝不在就绪集
  assert.ok(!computeReady(chainGraph, {}).ready.some((t) => t.id === "t-2"));
  assert.ok(!computeReady(chainGraph, { "t-1": { status: "running" } }).ready.some((t) => t.id === "t-2" || t.id === "t-3"));
});

test("「在等谁」：等待中的任务列出未 done 的前驱", () => {
  const r = computeReady(chainGraph, {});
  const w = r.waiting.find((w) => w.task.id === "t-3");
  assert.deepEqual(w.pendingDeps, ["t-2"]);
});

test("S1 串行：多个就绪只取 1，且按图声明序（确定性）", () => {
  const forest = {
    apiVersion: "taskmaster/v1",
    tasks: [
      { id: "a", statement: "A", deps: [], checks: ["x"] },
      { id: "b", statement: "B", deps: [], checks: ["x"] },
      { id: "c", statement: "C", deps: [], checks: ["x"] },
    ],
  };
  const r = computeReady(forest, {});
  assert.equal(r.ready.length, 3); // 森林：多个连通分量各自就绪
  const batch = selectBatch(r.ready, { limit: 1 });
  assert.deepEqual(batch.map((t) => t.id), ["a"]); // 声明序第一个
  // 重复计算结果一致（对账可重放）
  assert.deepEqual(selectBatch(computeReady(forest, {}).ready).map((t) => t.id), ["a"]);
});

test("死锁嗅探：就绪空 + 没在途 + 有等待 = 死锁；blocked 算在途；全 done = 完成", () => {
  // blocked 是在途（有人负责的卡住 ≠ 死锁）
  const blockedCase = computeReady(chainGraph, { "t-1": { status: "blocked" } });
  assert.equal(isDeadlocked(blockedCase), false);
  assert.equal(blockedCase.inFlight.length, 1);

  // 真死锁：无环图在正常状态下不可达，但改图（upsert 新版本）中途换图可造出
  // 「就绪空 + 在途空 + 有等待」——谓词本身用合成投影直接验证
  assert.equal(isDeadlocked({ ready: [], inFlight: [], waiting: [{ task: { id: "x" }, pendingDeps: ["ghost"] }] }), true);

  // 图完成判定
  assert.equal(isComplete(chainGraph, { "t-1": { status: "done" }, "t-2": { status: "done" }, "t-3": { status: "done" } }), true);
  assert.equal(isComplete(chainGraph, { "t-1": { status: "done" } }), false);
});
