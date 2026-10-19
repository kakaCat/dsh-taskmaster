// e2e 自愈集成测试（执行器 dead → 自动复活 → 新世代重派 → 超上限 blocked）：
// 与 monitor-self-heal.test.ts（单元：Monitor 单点语义）不同，本文件走完整引擎链路——
//   boot 装配（config.yaml 开 autoResume）→ 注册/确认/派发（真 reconciler 节拍）→
//   夹具杀进程（processAlive=false）→ 下一拍 monitor.sweep 自愈 →
//   confirmed 卡补投递签发新世代（新 runId、新绑定、新会话）→
//   死满 maxPerTask 次 → blocked + 报告落盘 + 不再自动重派。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../src/engine/boot.ts";
import { TaskmasterTools } from "../src/tools/tools.ts";
import { readProjection } from "../src/persister/projection-store.ts";
import { EventLog } from "../src/persister/event-log.ts";

const T0 = Date.parse("2026-10-18T12:00:00Z");
const at = (ms) => new Date(T0 + ms);

const singleTaskGraph = () => ({
  apiVersion: "taskmaster/v1",
  tasks: [{ id: "t-1", statement: "造数", deps: [], checks: [{ text: "落库", verify: "mechanical", command: "exit 0" }] }],
});

test("e2e：dead→自动复活→新世代重派→死满上限落 blocked、不再重派、报告落盘", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-e2e-selfheal-"));
  writeFileSync(
    join(dir, "config.yaml"),
    "enabled: true\nsilentMs: 60000\nautoResume:\n  enabled: true\n  maxPerTask: 2\n",
  );
  // 夹具：spawn 通道发会话号；dead 集合里的会话进程判定为死
  const dead = new Set<string>();
  let spawned = 0;
  const channels = { spawn: async () => ({ sessionId: `s-${++spawned}` }) };
  const adapters = { activityOf: () => 0, processAlive: (sid: string) => !dead.has(sid) };
  const engine: any = await boot(dir, { channels, adapters });
  const tm = new TaskmasterTools(engine);
  const beat = (ms) => engine.reconciler.reconcileAll(at(ms));
  const status = async (gid) => (await tm.status({ graphId: gid })).view;
  const eventsOf = (gid) => EventLog.open(join(dir, "events", `${gid}.events.ndjson`)).readAll();
  const projOf = (gid) => readProjection(join(dir, "state", `${gid}.state.json`)).data["t-1"];

  const reg = await tm.upsertGraph({ graphYaml: singleTaskGraph() });
  assert.equal(reg.ok, true);
  const gid = reg.graphId;

  // 出卡 → 确认 → 派发：t-1 running，世代①
  await beat(10);
  let v = await status(gid);
  assert.equal(v.plan.state, "pending");
  await tm.confirmPlan({ graphId: gid, planId: v.plan.planId, actor: "owner" });
  await beat(20);
  v = await status(gid);
  assert.equal(v.inFlight[0]?.status, "running");
  const run1 = v.inFlight[0].runId;

  // 断言一：自动复活——杀进程 → 下一拍探活 dead → 自愈（关旧绑定、翻 ready、事件留痕）
  dead.add("s-1");
  await beat(30);
  v = await status(gid);
  assert.equal(v.inFlight.length, 0, "自愈后旧世代已关、新世代未派，无在途");
  assert.equal(projOf(gid).status, "ready");
  const heal1 = eventsOf(gid).find((e) => e.kind === "task-resume" && e.auto === true);
  assert.ok(heal1, "应有 auto task-resume 事件");
  assert.equal(heal1.count, 1);
  assert.equal(heal1.runId, run1);

  // 断言二：新世代重派——下一拍 confirmed 卡补投递：新 runId、新绑定、新会话
  await beat(40);
  v = await status(gid);
  assert.equal(v.inFlight[0]?.status, "running");
  const run2 = v.inFlight[0].runId;
  assert.notEqual(run2, run1, "重派必须是新世代 runId");
  const b2 = engine.binder.byTask(gid, "t-1");
  assert.equal(b2.runId, run2);
  assert.equal(b2.sessionId, "s-2", "新绑定挂新会话");
  assert.equal(engine.binder.active().length, 1, "台账只有新世代一条活跃绑定");

  // 第二次死亡 → 自愈 #2（额度用尽）→ 再重派世代③
  dead.add("s-2");
  await beat(50);
  assert.equal(projOf(gid).status, "ready");
  await beat(60);
  v = await status(gid);
  const run3 = v.inFlight[0]?.runId;
  assert.equal(v.inFlight[0]?.status, "running");
  assert.ok(run3 && run3 !== run2, "第二次自愈后仍应重派新世代");

  // 断言三：死满 maxPerTask=2 → 第三次死亡落 blocked，不再自动重派，报告落盘
  dead.add("s-3");
  await beat(70);
  const st = projOf(gid);
  assert.equal(st.status, "blocked");
  assert.match(st.blockReason, /达上限（2\/2）/);
  // 绑定保留等人裁（人裁 resume 时才 supersede）
  assert.equal(engine.binder.byTask(gid, "t-1").runId, run3);
  // 事件流：2 次 auto resume + 1 次 blocked
  const evs = eventsOf(gid);
  assert.equal(evs.filter((e) => e.kind === "task-resume" && e.auto === true).length, 2);
  const blockedEv = evs.find((e) => e.kind === "blocked");
  assert.ok(blockedEv, "应有 blocked 事件");
  assert.equal(blockedEv.autoResumeCount, 2);
  // 报告落盘
  const reportFile = readdirSync(join(dir, "reports")).find((f) => f.includes("blocked"));
  assert.ok(reportFile, "reports/ 应有 blocked 报告");
  const report = JSON.parse(readFileSync(join(dir, "reports", reportFile), "utf8"));
  assert.equal(report.kind, "blocked");
  assert.equal(report.maxPerTask, 2);
  assert.equal(report.autoResumeCount, 2);

  // 后续任意拍：blocked 不进就绪集 → 不再自动重派（零新增 spawn、绑定不变、状态不变）
  await beat(80);
  await beat(90);
  assert.equal(spawned, 3, "blocked 后不再派发新会话");
  assert.equal(engine.binder.byTask(gid, "t-1").runId, run3);
  assert.equal(projOf(gid).status, "blocked");
  v = await status(gid);
  // 原 confirmed 卡仍在（仅匹配 ready 任务，blocked 不匹配 → 零投递）；关键是不再出新 pending 卡
  assert.notEqual(v.plan?.state, "pending", "blocked 无就绪集，不应再出计划卡");

  engine.lock.release();
});
