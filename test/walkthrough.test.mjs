// M1 走查脚本端到端测试（PRD 附录 13 步）+ tm_* 工具面测试（S1 工作项 #14）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../src/engine/boot.js";
import { TaskmasterTools } from "../src/tools/tools.js";
import { readProjection } from "../src/persister/projection-store.js";

const T0 = Date.parse("2026-10-18T12:00:00Z");
const at = (ms) => new Date(T0 + ms);

const walkGraph = () => ({
  apiVersion: "taskmaster/v1",
  tasks: [
    { id: "t-1", statement: "建表", deps: [], checks: [{ text: "表落库", verify: "mechanical", command: "exit 0" }, "人复核"] },
    { id: "t-2", statement: "接口", deps: ["t-1"], checks: [{ text: "联调", verify: "mechanical", command: "exit 0" }] },
    { id: "t-3", statement: "测试", deps: ["t-2"], checks: [{ text: "全绿", verify: "mechanical", command: "exit 0" }] },
  ],
});

test("M1 走查：注册→确认→派发→卡死→人裁→打回→补齐→图完成→暂停/停止/注销→kill 续调", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-walk-"));
  writeFileSync(join(dir, "config.yaml"), "enabled: true\nsilentMs: 60000");
  const sessions = { n: 0 };
  const channels = { spawn: async () => ({ sessionId: `s-${++sessions.n}` }) };
  let engine = await boot(dir, { channels, adapters: { activityOf: () => 0 } });
  let tm = new TaskmasterTools(engine);
  const beat = (ms = 10) => engine.reconciler.reconcileAll(at(ms));

  // ① 注册 3 任务图
  const reg = await tm.upsertGraph({ graphYaml: walkGraph() });
  assert.equal(reg.ok, true);
  const gid = reg.graphId;
  const status = async () => (await tm.status({ graphId: gid })).view;

  // ② 一拍：计划卡出（零工具调用的自动推进）
  await beat();
  let v = await status();
  assert.equal(v.plan.state, "pending");
  assert.equal(v.plan.batch[0].taskId, "t-1");

  // ③ 确认 → 下一拍补投递 → t-1 running + 绑定
  const c1 = await tm.confirmPlan({ graphId: gid, planId: v.plan.planId, actor: "owner" });
  assert.equal(c1.ok, true);
  await beat(20);
  v = await status();
  assert.equal(v.inFlight[0]?.status, "running");
  const runId1 = v.inFlight[0].runId;

   // ④ 模拟卡死：无信号增长超 TTL（60s）→ stalled 报人
  await beat(100_000); // startedAt=T0+20s → 沉默 80s > TTL
  v = await status();
  assert.equal(v.inFlight[0].liveness, "stalled");
  assert.ok(readdirSync(join(dir, "reports")).some((f) => f.includes("stalled")));

  // ⑤ 人裁 resume → 新世代重派（下一拍 confirmed 卡补投递）
  const ra = await tm.taskAction({ graphId: gid, taskId: "t-1", action: "resume", reason: "卡死重派", actor: "owner" });
  assert.equal(ra.ok, true);
  await beat(110_000);
  v = await status();
  const runId2 = v.inFlight[0].runId;
  assert.notEqual(runId2, runId1); // 新世代

  // ⑥ 旧世代交卷 → stale-run 拒收
  const stale = await tm.nodeUpdate({ graphId: gid, taskId: "t-1", runId: runId1, evidence: { 1: "x" } });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "stale-run");

  // ⑦ 证据缺失 → 打回（状态不变）
  const bad = await tm.nodeUpdate({ graphId: gid, taskId: "t-1", runId: runId2, evidence: {} });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "evidence-insufficient");
  assert.equal((await status()).inFlight[0].status, "running");

  // ⑧ 补齐证据 → 验收过 → done
  const good = await tm.nodeUpdate({ graphId: gid, taskId: "t-1", runId: runId2, evidence: { 1: "复核记录 review.md" } });
  assert.equal(good.ok, true);

  // ⑨ 级联：t-2 出卡 → 确认 → 派发 → 交卷 → t-3 → 图完成 asleep
  let clock = 120_000;
  for (const tid of ["t-2", "t-3"]) {
    await beat(clock++);
    clock += 10_000;
    v = await status();
    assert.equal(v.plan?.state, "pending", `${tid} 应出卡`);
    await tm.confirmPlan({ graphId: gid, planId: v.plan.planId, actor: "owner" });
    await beat(clock);
    clock += 10_000;
    v = await status();
    const run = v.inFlight.find((x) => x.taskId === tid);
    const sub = await tm.nodeUpdate({ graphId: gid, taskId: tid, runId: run.runId, evidence: {} });
    assert.equal(sub.ok, true, `${tid} 验收过`);
  }
  await beat(clock + 10_000);
  v = await status();
  assert.equal(v.lifecycle, "asleep"); // 图完成
  assert.equal(v.done, 3);

  // ⑩ kill 应用（丢全部对象 + 释放锁 = 进程退出）→ 重启：图已 asleep，零重复派发
  engine.lock.release(); // 模拟进程死亡：锁随进程消失
  engine = await boot(dir, { channels, adapters: { activityOf: () => 0 } });
  tm = new TaskmasterTools(engine);
  const s = await engine.reconciler.reconcileAll(at(clock + 20_000));
  assert.ok(s.find((x) => x.graphId === gid).skipped); // asleep 跳过
  assert.equal(sessions.n, 4); // 全程 spawn 4 次（t-1 两次 + t-2 + t-3）→ 重启零新增
});

test("走查支线：投递失败回滚 + 暂停/停止/注销", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-walk2-"));
  writeFileSync(join(dir, "config.yaml"), "enabled: true");
  const engine = await boot(dir, { channels: {}, adapters: {} }); // 无通道 = 执行面全挂
  const tm = new TaskmasterTools(engine);
  const reg = await tm.upsertGraph({ graphYaml: walkGraph() });
  const gid = reg.graphId;

  await engine.reconciler.reconcileAll();
  const v = (await tm.status({ graphId: gid })).view;
  await tm.confirmPlan({ graphId: gid, planId: v.plan.planId });
  // 下一拍：补投递 → 全挂 → 回滚 ready + 降级
  const s = await engine.reconciler.reconcileAll();
  assert.ok(s[0].actions.some((a) => a.startsWith("delivery-failed")));
  assert.equal(engine.guard.degraded, true);
  const st = readProjection(join(dir, "state", `${gid}.state.json`));
  assert.equal(st.data["t-1"].status, "ready"); // 回滚

  // 暂停 → 恢复 → 停止 → 收口 → 注销
  assert.equal((await tm.graphCtl({ graphId: gid, action: "pause", actor: "owner" })).ok, true);
  assert.equal((await tm.status({ graphId: gid })).view.lifecycle, "paused");
  assert.equal((await tm.graphCtl({ graphId: gid, action: "resume", actor: "owner" })).ok, true);
  assert.equal((await tm.graphCtl({ graphId: gid, action: "stop", actor: "owner" })).ok, true);
  await engine.reconciler.reconcileAll(); // 清点收口
  assert.equal((await tm.status({ graphId: gid })).view.lifecycle, "stopped");
  // 注销不带确认 → confirm-required
  assert.equal((await tm.graphCtl({ graphId: gid, action: "deregister", actor: "owner" })).code, "confirm-required");
  assert.equal((await tm.graphCtl({ graphId: gid, action: "deregister", actor: "owner", confirm: true })).ok, true);
  assert.equal((await tm.status({ graphId: gid })).view.lifecycle, "deregistered");
});
