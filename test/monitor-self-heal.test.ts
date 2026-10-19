// monitor 自愈（autoResume）单元测试：自动复活 / 计数持久化 / 超上限落 blocked
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Monitor } from "../src/monitor/monitor.ts";
import { Binder } from "../src/binder/binder.ts";
import { readProjection, casWriteProjection } from "../src/persister/projection-store.ts";
import { EventLog } from "../src/persister/event-log.ts";
import { rebuildProjection } from "../src/engine/rebuild.ts";

function scratch({ autoResume }: any = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tm-selfheal-"));
  if (autoResume) {
    writeFileSync(
      join(dir, "config.yaml"),
      `enabled: true\nautoResume:\n  enabled: ${autoResume.enabled}\n  maxPerTask: ${autoResume.maxPerTask}\n`,
    );
  }
  return dir;
}

const T0 = Date.parse("2026-10-18T12:00:00Z");
const at = (ms) => new Date(T0 + ms);

/** 造一条在途运行（绑定 + 投影 running），返回绑定 */
function seedRunning(dir, { sessionId = "s-1", startedAt = at(0) } = {}) {
  const binder = new Binder(dir);
  const b = binder.open({ graphId: "g-1", graphVersion: 1, taskId: "t-1", sessionId, channel: "spawn" }, startedAt);
  const p = join(dir, "state/g-1.state.json");
  const proj = readProjection(p);
  casWriteProjection(p, proj.version, { ...(proj.data ?? {}), "t-1": { status: "running", runId: b.runId } });
  return b;
}

const statusOf = (dir) => readProjection(join(dir, "state/g-1.state.json")).data["t-1"];
const eventsOf = (dir) => EventLog.open(join(dir, "events/g-1.events.ndjson")).readAll();
const deadMonitor = (dir, extra = {}) =>
  new Monitor(dir, { binder: new Binder(dir), adapters: { activityOf: () => 0, processAlive: () => false }, ...extra });

test("缺省关闭：dead 只上报，不动 status、不关绑定（现状行为不变）", async () => {
  const dir = scratch(); // 无 config.yaml → autoResume.enabled=false
  seedRunning(dir);
  const r = await deadMonitor(dir).sweep("g-1", at(10_000));
  assert.equal(r[0].liveness, "dead");
  assert.equal(r[0].autoResumed, undefined); // 无自愈字段
  assert.equal(statusOf(dir).status, "running");
  assert.equal(new Binder(dir).active().length, 1);
});

test("自动复活：与 tm_task_action resume 同语义——关绑定、status→ready、runId 作废、事件留痕", async () => {
  const dir = scratch({ autoResume: { enabled: true, maxPerTask: 2 } });
  const b = seedRunning(dir);
  const r = await deadMonitor(dir).sweep("g-1", at(10_000));
  assert.equal(r[0].liveness, "dead");
  assert.equal(r[0].autoResumed, true);
  assert.equal(r[0].count, 1);
  // 关绑定（旧世代 supersede）
  assert.equal(new Binder(dir).active().length, 0);
  // status→ready、runId 作废（新世代等下一拍派发签发）
  assert.deepEqual(statusOf(dir), { status: "ready", runId: null });
  // 事件留痕：kind 复用 task-resume（重建重放同口径），auto/actor 区分人裁
  const ev = eventsOf(dir).find((e) => e.kind === "task-resume");
  assert.ok(ev, "应有 task-resume 事件");
  assert.equal(ev.auto, true);
  assert.equal(ev.actor, "auto-resume");
  assert.equal(ev.count, 1);
  assert.equal(ev.runId, b.runId);
});

test("重建一致性：auto-resume 事件按既有 fold 重放成 ready（崩溃恢复零漂移）", async () => {
  const dir = scratch({ autoResume: { enabled: true, maxPerTask: 2 } });
  seedRunning(dir);
  await deadMonitor(dir).sweep("g-1", at(10_000));
  const rebuilt = rebuildProjection({ tasks: [{ id: "t-1" }] }, eventsOf(dir));
  assert.deepEqual(rebuilt["t-1"], { status: "ready", runId: null });
});

test("计数持久化：新实例（模拟重启）后续死继续计数，人裁 resume 不占额度", async () => {
  const dir = scratch({ autoResume: { enabled: true, maxPerTask: 2 } });
  // 人裁 resume 事件（无 auto 标记）不应计入自愈额度
  eventsOf(dir); // 确保日志文件路径就绪
  EventLog.open(join(dir, "events/g-1.events.ndjson")).append("task-resume", { taskId: "t-1", actor: "human-session", reason: "人裁" });

  // 第一次死亡 → 自愈 #1（人裁事件不占额度，count 从 0 起）
  seedRunning(dir, { sessionId: "s-1" });
  const r1 = await deadMonitor(dir).sweep("g-1", at(10_000));
  assert.equal(r1[0].count, 1);

  // 模拟重派新世代后又死亡；全新 Monitor/Binder 实例（模拟重启）→ 计数从事件流读回
  seedRunning(dir, { sessionId: "s-2", startedAt: at(20_000) });
  const r2 = await deadMonitor(dir).sweep("g-1", at(30_000));
  assert.equal(r2[0].autoResumed, true);
  assert.equal(r2[0].count, 2);
  assert.equal(eventsOf(dir).filter((e) => e.kind === "task-resume" && e.auto === true).length, 2);
});

test("超上限：落 blocked + 事件 + reports 落盘，绑定保留等人裁，不重复上报", async () => {
  const dir = scratch({ autoResume: { enabled: true, maxPerTask: 1 } });
  // 第一次死亡 → 自愈 #1（额度用尽）
  seedRunning(dir, { sessionId: "s-1" });
  await deadMonitor(dir).sweep("g-1", at(10_000));
  // 重派后第二次死亡 → 超上限落 blocked
  const b2 = seedRunning(dir, { sessionId: "s-2", startedAt: at(20_000) });
  const r = await deadMonitor(dir).sweep("g-1", at(30_000));
  assert.equal(r[0].liveness, "dead");
  assert.equal(r[0].autoResumed, false);
  assert.equal(r[0].exhausted, true);
  // status→blocked，带原因；绑定保留（人裁 resume 时 supersede）
  const st = statusOf(dir);
  assert.equal(st.status, "blocked");
  assert.match(st.blockReason, /达上限（1\/1）/);
  assert.equal(new Binder(dir).byTask("g-1", "t-1")!.runId, b2.runId);
  // blocked 事件 + 报告落盘
  const ev = eventsOf(dir).find((e) => e.kind === "blocked");
  assert.ok(ev, "应有 blocked 事件");
  assert.equal(ev.autoResumeCount, 1);
  const report = readdirSync(join(dir, "reports")).find((f) => f.includes("blocked"));
  assert.ok(report, "应有 blocked 报告");
  const doc = JSON.parse(readFileSync(join(dir, "reports", report), "utf8"));
  assert.equal(doc.kind, "blocked");
  assert.equal(doc.maxPerTask, 1);
  // 重复巡检：liveness 已是 dead → 不重复翻 blocked、不重复写报告
  const before = readdirSync(join(dir, "reports")).length;
  await deadMonitor(dir).sweep("g-1", at(40_000));
  assert.equal(readdirSync(join(dir, "reports")).length, before);
  // 重建重放 blocked 同口径
  const rebuilt = rebuildProjection({ tasks: [{ id: "t-1" }] }, eventsOf(dir));
  assert.equal(rebuilt["t-1"].status, "blocked");
});

test("构造注入：autoResume 参数直给（不走 config.yaml）同样生效", async () => {
  const dir = scratch(); // 无 config.yaml
  seedRunning(dir);
  const m = deadMonitor(dir, { autoResume: { enabled: true, maxPerTask: 1 } });
  const r = await m.sweep("g-1", at(10_000));
  assert.equal(r[0].autoResumed, true);
  assert.equal(statusOf(dir).status, "ready");
});
