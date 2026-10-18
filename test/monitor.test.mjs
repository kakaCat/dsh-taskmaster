// monitor 单元测试（S1 工作项 #8，覆盖 FR-7 S1 部分 / AC-7.1）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Monitor } from "../src/monitor/monitor.js";
import { Binder } from "../src/binder/binder.js";
import { readProjection, casWriteProjection } from "../src/persister/projection-store.js";

function scratch() {
  return mkdtempSync(join(tmpdir(), "tm-monitor-"));
}

const T0 = Date.parse("2026-10-18T12:00:00Z");
const at = (ms) => new Date(T0 + ms);

function seedRunning(dir, { startedAt = at(0) } = {}) {
  const binder = new Binder(dir);
  const b = binder.open({ graphId: "g-1", graphVersion: 1, taskId: "t-1", sessionId: "s-1", channel: "spawn" }, startedAt);
  const p = join(dir, "state/g-1.state.json");
  const proj = readProjection(p);
  casWriteProjection(p, proj.version, { "t-1": { status: "running", runId: b.runId } });
  return b;
}

test("alive：事件 seq 增长 → alive，游标推进", () => {
  const dir = scratch();
  seedRunning(dir);
  const m = new Monitor(dir, { binder: new Binder(dir), adapters: { activityOf: () => 5 } });
  const r = m.sweep("g-1", at(10_000));
  assert.equal(r[0].liveness, "alive");
  assert.equal(new Binder(dir).byTask("t-1").lastEventSeq, 5);
});

test("silent：无增长但未超 TTL → silent，不上报", () => {
  const dir = scratch();
  seedRunning(dir);
  const m = new Monitor(dir, { binder: new Binder(dir), adapters: { activityOf: () => 0 }, silentMs: 90_000 });
  const r = m.sweep("g-1", at(30_000)); // 30s < 90s
  assert.equal(r[0].liveness, "silent");
  assert.throws(() => readdirSync(join(dir, "reports"))); // 没有 reports 目录 = 零上报
});

test("AC-7.1：执行者停掉（无信号增长）超 TTL → stalled + 上报落盘", () => {
  const dir = scratch();
  seedRunning(dir);
  const m = new Monitor(dir, { binder: new Binder(dir), adapters: { activityOf: () => 0 }, silentMs: 90_000 });
  const r = m.sweep("g-1", at(120_000)); // 120s > 90s
  assert.equal(r[0].liveness, "stalled");
  const reports = readdirSync(join(dir, "reports"));
  assert.equal(reports.length, 1);
  assert.ok(reports[0].includes("stalled"));
  // 重复巡检不重复上报
  m.sweep("g-1", at(150_000));
  assert.equal(readdirSync(join(dir, "reports")).length, 1);
});

test("dead：进程消失 → dead + 上报；与 stalled 是不同的报", () => {
  const dir = scratch();
  seedRunning(dir);
  const m = new Monitor(dir, {
    binder: new Binder(dir),
    adapters: { activityOf: () => 0, processAlive: () => false },
  });
  const r = m.sweep("g-1", at(10_000));
  assert.equal(r[0].liveness, "dead");
  assert.ok(readdirSync(join(dir, "reports"))[0].includes("dead"));
});

test("活性是投影：stalled/dead 不改任务 status（仍 running），绑定保留", () => {
  const dir = scratch();
  seedRunning(dir);
  const m = new Monitor(dir, { binder: new Binder(dir), adapters: { activityOf: () => 0 }, silentMs: 1000 });
  m.sweep("g-1", at(120_000));
  const st = readProjection(join(dir, "state/g-1.state.json"));
  assert.equal(st.data["t-1"].status, "running"); // 主状态机不动
  assert.equal(new Binder(dir).active().length, 1); // 绑定保留等人裁
});

test("活性可恢复：stalled 后信号恢复增长 → 回 alive（上报留痕不撤）", () => {
  const dir = scratch();
  seedRunning(dir);
  let seq = 0;
  const m = new Monitor(dir, { binder: new Binder(dir), adapters: { activityOf: () => seq }, silentMs: 1000 });
  m.sweep("g-1", at(120_000));
  assert.equal(new Binder(dir).byTask("t-1").liveness, "stalled");
  seq = 9; // 执行者活过来了
  const r = m.sweep("g-1", at(130_000));
  assert.equal(r[0].liveness, "alive");
  assert.equal(new Binder(dir).byTask("t-1").lastEventSeq, 9);
});

test("持久化：活性元数据跨实例读回（Boot 重挂的输入）", () => {
  const dir = scratch();
  seedRunning(dir);
  const m = new Monitor(dir, { binder: new Binder(dir), adapters: { activityOf: () => 0 }, silentMs: 1000 });
  m.sweep("g-1", at(120_000));
  const reopened = new Binder(dir);
  assert.equal(reopened.byTask("t-1").liveness, "stalled");
});
