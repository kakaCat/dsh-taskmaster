// 工具面契约回归（真宿主 dsh-tools 的 lossless JSON 输出契约 / 属主权限 / 降级可见性 /
// 未知键校验 / enabled=false 可读写 / ready 归类）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { boot } from "../src/engine/boot.ts";
import { TaskmasterTools } from "../src/tools/tools.ts";

function scratch(config = "enabled: true\nbeatMs: 30000\nsilentMs: 60000") {
  const dir = mkdtempSync(join(tmpdir(), "tm-contract-"));
  writeFileSync(join(dir, "config.yaml"), config);
  return dir;
}

const graph = () => ({ apiVersion: "taskmaster/v1", tasks: [{ id: "t-1", statement: "任务一", checks: ["判据一"] }] });

/** 断言返回对象是 lossless JSON 且没有 value=undefined 的字段（真宿主会直接拒绝这种输出） */
function assertLossless(r: any) {
  const json = JSON.stringify(r);
  assert.ok(json !== undefined, "结果不可 JSON 化");
  assert.deepEqual(JSON.parse(json), r, "结果不是 lossless JSON");
  for (const [k, v] of Object.entries(r)) assert.notEqual(v, undefined, `字段 ${k} 是 undefined`);
}

test("错误输出契约：错误码可透出，且结果里不含 undefined 字段", async () => {
  const dir = scratch();
  const engine: any = await boot(dir, { channels: {} });
  const tm = new TaskmasterTools(engine);
  const reg = await tm.upsertGraph({ graphYaml: yaml.dump(graph()) });
  const gid = reg.graphId;

  // 未派发就交卷 → not-running（旧实现被宿主替换成 "tool returned invalid output"）
  const r = await tm.nodeUpdate({ graphId: gid, taskId: "t-1", runId: "r-fake", evidence: {} });
  assert.equal(r.ok, false);
  assert.equal(r.code, "not-running");
  assertLossless(r);

  // 计划卡不存在 → plan-not-pending
  const c = await tm.confirmPlan({ graphId: gid, planId: "p-missing" });
  assert.equal(c.ok, false);
  assert.equal(c.code, "plan-not-pending");
  assertLossless(c);

  // 未知人裁动作 → bad-action（不抛）
  const bad = await tm.taskAction({ graphId: gid, taskId: "t-1", action: "nope" });
  assert.equal(bad.code, "bad-action");
  assertLossless(bad);

  engine.lock.release();
});

test("tm_status：图不存在 → ok + notice（IF-4 只读不失败）；出卡后 ready 不混入 inFlight", async () => {
  const dir = scratch();
  const engine: any = await boot(dir, { channels: {} });
  const tm = new TaskmasterTools(engine);

  const missing = await tm.status({ graphId: "g-nope" });
  assert.equal(missing.ok, true);
  assert.match(missing.view.notice, /不存在/);
  assertLossless(missing);

  const reg = await tm.upsertGraph({ graphYaml: yaml.dump(graph()) });
  await engine.reconciler.reconcileAll();
  const v: any = (await tm.status({ graphId: reg.graphId })).view;
  assert.deepEqual(v.ready, ["t-1"]); // 已物化的 ready 任务
  assert.equal(v.inFlight.length, 0); // 不是在途
  assert.equal(v.plan.state, "pending");
  assertLossless(v);
  engine.lock.release();
});

test("权限：非属主 confirm/graph_ctl/task_action/改图 → authority-required", async () => {
  const dir = scratch();
  const engine: any = await boot(dir, { channels: {} });
  const tm = new TaskmasterTools(engine);
  const reg = await tm.upsertGraph({ graphYaml: yaml.dump(graph()), ownerSessionId: "owner-a" });
  const gid = reg.graphId;

  const other = "session-other";
  const c = await tm.confirmPlan({ graphId: gid, planId: "p-x", actor: other });
  assert.equal(c.code, "authority-required");
  assertLossless(c);

  const g = await tm.graphCtl({ graphId: gid, action: "pause", actor: other });
  assert.equal(g.code, "authority-required");

  const t = await tm.taskAction({ graphId: gid, taskId: "t-1", action: "resume", actor: other });
  assert.equal(t.code, "authority-required");

  const u = await tm.upsertGraph({ graphYaml: yaml.dump(graph()), graphId: gid, ownerSessionId: other });
  assert.equal(u.code, "authority-required");

  // 属主自己做合法动作不受影响（此处无卡，报 plan-not-pending 说明权限已过）
  const own = await tm.confirmPlan({ graphId: gid, planId: "p-x", actor: "owner-a" });
  assert.equal(own.code, "plan-not-pending");
  engine.lock.release();
});

test("降级可见且可恢复：投递失败 → engine.degraded=true；tm_engine_start 清除", async () => {
  const dir = scratch();
  const engine: any = await boot(dir, { channels: {}, adapters: {} }); // 执行面全挂
  const tm = new TaskmasterTools(engine);
  const reg = await tm.upsertGraph({ graphYaml: yaml.dump(graph()), ownerSessionId: "owner-d" });

  await engine.reconciler.reconcileAll();
  const card = (await tm.status({ graphId: reg.graphId })).view.plan;
  await tm.confirmPlan({ graphId: reg.graphId, planId: card.planId, actor: "owner-d" });
  await engine.reconciler.reconcileAll(); // 尝试投递 → 全挂 → degraded

  let v: any = (await tm.status({ graphId: reg.graphId })).view;
  assert.equal(v.engine.degraded, true);
  assert.match(v.engine.degradedReason, /all-channels-down/);
  assertLossless(v);

  const started = await tm.engineCtl({ action: "start" });
  assert.equal(started.ok, true);
  v = (await tm.status({ graphId: reg.graphId })).view;
  assert.equal(v.engine.degraded, false);
  engine.lock.release();
});

test("未知键：图/任务/判据的拼错字段都以 invalid-graph 拒绝（不静默忽略）", async () => {
  const dir = scratch();
  const engine: any = await boot(dir, { channels: {} });
  const tm = new TaskmasterTools(engine);

  const badGraph = await tm.upsertGraph({
    graphYaml: yaml.dump({ apiVersion: "taskmaster/v1", unknownTopLevel: 1, tasks: [{ id: "t", statement: "x", checks: ["c"] }] }),
  });
  assert.equal(badGraph.code, "invalid-graph");
  assert.ok(badGraph.issues.some((i: any) => i.target === "$.unknownTopLevel"));
  assertLossless(badGraph);

  const badTask = await tm.upsertGraph({
    graphYaml: yaml.dump({ apiVersion: "taskmaster/v1", tasks: [{ id: "t", statement: "x", checks: ["c"], unrelatedField: 1 }] }),
  });
  assert.equal(badTask.code, "invalid-graph");
  assert.ok(badTask.issues.some((i: any) => i.target === "tasks[0].unrelatedField"));

  const badCheck = await tm.upsertGraph({
    graphYaml: yaml.dump({ apiVersion: "taskmaster/v1", tasks: [{ id: "t", statement: "x", checks: [{ text: "c", bogus: true }] }] }),
  });
  assert.equal(badCheck.code, "invalid-graph");
  assert.ok(badCheck.issues.some((i: any) => i.target === "tasks[0].checks[0].bogus"));
  engine.lock.release();
});

test("enabled=false：boot 仍返回读写核心模块（store/binder/gate/ctl/acceptor）", async () => {
  const dir = scratch("enabled: false\n");
  const engine: any = await boot(dir, { channels: {} });
  assert.equal(engine.disabled, true);
  assert.ok(engine.store && engine.binder && engine.gate && engine.ctl && engine.acceptor);
  assert.equal(engine.lock, undefined); // 关闭态不占单写者锁
  const tm = new TaskmasterTools(engine);
  const reg = await tm.upsertGraph({ graphYaml: yaml.dump(graph()) });
  assert.equal(reg.ok, true);
  const v = await tm.status({ graphId: reg.graphId });
  assert.equal(v.ok, true);
  assert.equal(v.view.engine.enabled, false);
});

test("evidence-insufficient 打回：missing 数组透出且是 lossless JSON", async () => {
  const dir = scratch();
  const engine: any = await boot(dir, { channels: { spawn: async () => ({ sessionId: "s-1" }) } });
  const tm = new TaskmasterTools(engine);
  const reg = await tm.upsertGraph({ graphYaml: yaml.dump(graph()), ownerSessionId: "owner-e" });

  await engine.reconciler.reconcileAll();
  const card = (await tm.status({ graphId: reg.graphId })).view.plan;
  await tm.confirmPlan({ graphId: reg.graphId, planId: card.planId, actor: "owner-e" });
  await engine.reconciler.reconcileAll();
  const v: any = (await tm.status({ graphId: reg.graphId })).view;
  assert.equal(v.inFlight[0].status, "running");
  const runId = v.inFlight[0].runId;

  const bad = await tm.nodeUpdate({ graphId: reg.graphId, taskId: "t-1", runId, evidence: {} });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "evidence-insufficient");
  assert.equal(bad.missing.length, 1);
  assertLossless(bad);
  // 状态不变
  assert.equal((await tm.status({ graphId: reg.graphId })).view.inFlight[0].status, "running");
  engine.lock.release();
});

test("注销是终态：deregister 后改图 → bad-transition（不再产生永不派发的死版本）", async () => {
  const dir = scratch();
  const engine: any = await boot(dir, { channels: {} });
  const tm = new TaskmasterTools(engine);
  const reg = await tm.upsertGraph({ graphYaml: yaml.dump(graph()), ownerSessionId: "owner-x" });
  const d = await tm.graphCtl({ graphId: reg.graphId, action: "deregister", confirm: true, actor: "owner-x" });
  assert.equal(d.ok, true);
  const u = await tm.upsertGraph({ graphYaml: yaml.dump(graph()), graphId: reg.graphId, ownerSessionId: "owner-x" });
  assert.equal(u.ok, false);
  assert.equal(u.code, "bad-transition");
  assertLossless(u);
  engine.lock.release();
});
