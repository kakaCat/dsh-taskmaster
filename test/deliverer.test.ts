// deliverer 单元测试（S1 工作项 #6，覆盖 FR-10 / AC-10.1/10.2）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deliverer, DeliveryFailedError, DeliveryConflictError, DeliveryDeferredError, assemblePackage } from "../src/deliverer/deliverer.ts";
import { Binder } from "../src/binder/binder.ts";
import { readProjection, casWriteProjection } from "../src/persister/projection-store.ts";

function scratch() {
  return mkdtempSync(join(tmpdir(), "tm-deliver-"));
}

const graph = {
  apiVersion: "taskmaster/v1",
  tasks: [
    { id: "t-1", statement: "建表", deps: [], checks: ["表落库"], writeScopes: ["db/"], roundBudget: 10 },
    { id: "t-2", statement: "接口", deps: ["t-1"], checks: [{ text: "联调过", verify: "mechanical" }], writeScopes: ["src/api/"] },
  ],
};

/** 把任务置为 ready（模拟确认闸通过后调度器的占位前状态） */
function seedReady(dir, graphId, taskId) {
  const p = join(dir, "state", `${graphId}.state.json`);
  const proj = readProjection(p);
  casWriteProjection(p, proj.version, { ...(proj.data ?? {}), [taskId]: { status: "ready" } });
}

const okChannel = (id) => async () => ({ sessionId: id });
const failChannel = async () => {
  throw new Error("channel down");
};

test("成功路径：占位→投递→建绑定→running，runs/ 留痕含 runId", async () => {
  const dir = scratch();
  seedReady(dir, "g-1", "t-1");
  const d = new Deliverer(dir, { channels: { spawn: okChannel("s-1") }, binder: new Binder(dir) });
  const r = await d.deliver({ graphId: "g-1", graphVersion: 1, graph, task: graph.tasks[0] });
  assert.equal(r.delivered, true);
  assert.equal(r.channel, "spawn");
  assert.equal(r.sessionId, "s-1");
  // 状态 running
  const st = JSON.parse(readFileSync(join(dir, "state/g-1.state.json"), "utf8"));
  assert.equal(st.data["t-1"].status, "running");
  assert.equal(st.data["t-1"].runId, r.runId);
  // 留痕
  const rec = JSON.parse(readFileSync(join(dir, "runs", r.runId, "delivery.json"), "utf8"));
  assert.equal(rec.result, "delivered");
});

test("通道降级：高档挂 → 用下一档；留痕记录每档尝试", async () => {
  const dir = scratch();
  seedReady(dir, "g-1", "t-1");
  const d = new Deliverer(dir, {
    channels: { startActivation: failChannel, spawn: okChannel("s-9") }, // branch 未注册 = unavailable
    binder: new Binder(dir),
  });
  const r = await d.deliver({ graphId: "g-1", graphVersion: 1, graph, task: graph.tasks[0] });
  assert.equal(r.channel, "spawn");
  const rec = JSON.parse(readFileSync(join(dir, "runs", r.runId, "delivery.json"), "utf8"));
  assert.deepEqual(rec.attempts.map((a) => [a.channel, a.ok]), [
    ["startActivation", false],
    ["branch", false],
    ["spawn", true],
  ]);
});

test("AC-10.1：全通道挂 → 回滚 ready、零绑定残留、失败留痕、不自动重试", async () => {
  const dir = scratch();
  seedReady(dir, "g-1", "t-1");
  const binder = new Binder(dir);
  const d = new Deliverer(dir, { channels: { spawn: failChannel }, binder });
  await assert.rejects(
    () => d.deliver({ graphId: "g-1", graphVersion: 1, graph, task: graph.tasks[0] }),
    (e) => e instanceof DeliveryFailedError && e.code === "delivery-failed",
  );
  // 回滚 ready
  const st = JSON.parse(readFileSync(join(dir, "state/g-1.state.json"), "utf8"));
  assert.equal(st.data["t-1"].status, "ready");
  // 零绑定残留
  assert.equal(binder.active().length, 0);
  // 失败留痕在 runs/failed/
  assert.ok(existsSync(join(dir, "runs", "failed")));
});

test("AC-10.2：并发第二次投递 → dispatch-conflict（at-most-once 的占位侧）", async () => {
  const dir = scratch();
  seedReady(dir, "g-1", "t-1");
  const d = new Deliverer(dir, { channels: { spawn: okChannel("s-1") }, binder: new Binder(dir) });
  await d.deliver({ graphId: "g-1", graphVersion: 1, graph, task: graph.tasks[0] });
  await assert.rejects(
    () => d.deliver({ graphId: "g-1", graphVersion: 1, graph, task: graph.tasks[0] }),
    DeliveryConflictError,
  );
});

test("绑定冲突（sessionId 被占）→ 回滚 ready + 留痕 binding-conflict", async () => {
  const dir = scratch();
  seedReady(dir, "g-1", "t-1");
  seedReady(dir, "g-1", "t-2");
  const binder = new Binder(dir);
  const d = new Deliverer(dir, { channels: { spawn: okChannel("s-1") }, binder });
  await d.deliver({ graphId: "g-1", graphVersion: 1, graph, task: graph.tasks[0] });
  // t-2 也被分到 s-1（宿主侧错误）：binder 不变量拦截 → 回滚
  await assert.rejects(() => d.deliver({ graphId: "g-1", graphVersion: 1, graph, task: graph.tasks[1] }));
  const st = JSON.parse(readFileSync(join(dir, "state/g-1.state.json"), "utf8"));
  assert.equal(st.data["t-2"].status, "ready");
});

test("任务包视野最小化：只含本任务投影 + 前驱产物路径摘要", () => {
  const pkg = assemblePackage(graph, graph.tasks[1], {
    artifacts: { "t-1": { path: "db/schema.sql", summary: "用户表+订单表" } },
    binding: { graphId: "g-1", graphVersion: 1 },
  });
  assert.equal(pkg.taskId, "t-2");
  assert.equal(pkg.deps[0].artifact.path, "db/schema.sql");
  assert.ok(!("tasks" in pkg)); // 不含全图
  assert.deepEqual(pkg.writeScopes, ["src/api/"]);
});

test("启动期竞态：执行面 pending → DeliveryDeferred，零占位零留痕（下拍重试）", async () => {
  const dir = scratch();
  seedReady(dir, "g-1", "t-1");
  const binder = new Binder(dir);
  const d = new Deliverer(dir, {
    channels: { spawn: okChannel("s-should-not-run"), available: () => false, pending: () => true },
    binder,
  });
  await assert.rejects(
    () => d.deliver({ graphId: "g-1", graphVersion: 1, graph, task: graph.tasks[0] }),
    (e) => e instanceof DeliveryDeferredError && e.code === "delivery-deferred",
  );
  // 没占位、没残留绑定、没失败留痕
  const st = JSON.parse(readFileSync(join(dir, "state/g-1.state.json"), "utf8"));
  assert.equal(st.data["t-1"].status, "ready");
  assert.equal(binder.active().length, 0);
  assert.equal(existsSync(join(dir, "runs")), false);
});

test("执行面确实不存在（非 pending）→ 仍按 delivery-failed 降级", async () => {
  const dir = scratch();
  seedReady(dir, "g-1", "t-1");
  const d = new Deliverer(dir, {
    channels: { spawn: failChannel, available: () => false, pending: () => false },
    binder: new Binder(dir),
  });
  await assert.rejects(
    () => d.deliver({ graphId: "g-1", graphVersion: 1, graph, task: graph.tasks[0] }),
    (e) => e instanceof DeliveryFailedError,
  );
});
