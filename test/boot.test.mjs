// boot 单元测试（S1 工作项 #11，覆盖 FR-15 / AC-15.1 + NFR-2 重启续调 + NFR-5 崩溃重建）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, BootRefusedError } from "../src/engine/boot.js";
import { rebuildProjection } from "../src/engine/rebuild.js";
import { GraphStore } from "../src/graph-store/graph-store.js";
import { Binder } from "../src/binder/binder.js";
import { readProjection, casWriteProjection } from "../src/persister/projection-store.js";
import { EventLog } from "../src/persister/event-log.js";
import { SingleWriterLock } from "../src/persister/lock.js";

function scratch() {
  return mkdtempSync(join(tmpdir(), "tm-boot-"));
}

function enableConfig(dir, extra = {}) {
  writeFileSync(join(dir, "config.yaml"), `enabled: true\n${Object.entries(extra).map(([k, v]) => `${k}: ${v}`).join("\n")}`);
}

const graph = () => ({
  apiVersion: "taskmaster/v1",
  tasks: [
    { id: "t-1", statement: "建表", deps: [], checks: [{ text: "c", verify: "mechanical", command: "exit 0" }] },
    { id: "t-2", statement: "接口", deps: ["t-1"], checks: ["联调"] },
  ],
});

/** 造一个"运行中"现场：图 + t-1 running + 绑定 + 事件 */
function seedInFlight(dir) {
  const store = new GraphStore(dir);
  const { graphId } = store.upsert(graph());
  const binder = new Binder(dir);
  const b = binder.open({ graphId, graphVersion: 1, taskId: "t-1", sessionId: "s-1", channel: "spawn" });
  const ev = EventLog.open(join(dir, "events", `${graphId}.events.ndjson`));
  ev.append("ready", { tasks: ["t-1"] });
  ev.append("dispatch", { taskId: "t-1", runId: b.runId, channel: "spawn" });
  const p = join(dir, "state", `${graphId}.state.json`);
  casWriteProjection(p, 0, { "t-1": { status: "running", runId: b.runId } });
  return { graphId, runId: b.runId };
}

test("enabled=false → disabled，零锁零装配", async () => {
  const dir = scratch(); // 无 config.yaml = 默认关
  const r = await boot(dir);
  assert.equal(r.disabled, true);
  assert.equal(existsSync(join(dir, ".engine.lock")), false);
});

test("AC-15.1：重启续调——在途重挂、投影重建、下一拍正常出卡", async () => {
  const dir = scratch();
  enableConfig(dir);
  const { graphId } = seedInFlight(dir);
  // 「kill 应用」= 全部对象丢弃，重新 boot
  const r = await boot(dir, { adapters: { processAlive: () => true } });
  assert.equal(r.disabled, false);
  assert.deepEqual(r.bootReport.reattach.reattached, ["t-1"]);
  // 投影重建后与现场一致
  const st = readProjection(join(dir, "state", `${graphId}.state.json`));
  assert.equal(st.data["t-1"].status, "running");
  // 心跳接管：t-1 在跑（不就绪），无卡出；直接验证 reconcile 不炸
  const s = await r.reconciler.reconcileGraph(graphId);
  assert.ok(Array.isArray(s.actions));
});

test("崩溃重建：删掉 state.json，boot 从事件流重建（NFR-5）", async () => {
  const dir = scratch();
  enableConfig(dir);
  const { graphId, runId } = seedInFlight(dir);
  // 追加 accept 事件（t-1 已完成），然后删掉投影
  EventLog.open(join(dir, "events", `${graphId}.events.ndjson`)).append("accept", { taskId: "t-1", runId });
  rmSync(join(dir, "state", `${graphId}.state.json`));
  const r = await boot(dir, { adapters: { processAlive: () => true } });
  const st = readProjection(join(dir, "state", `${graphId}.state.json`));
  assert.equal(st.data["t-1"].status, "done"); // 从事件重建出 done
  assert.equal(st.data["t-2"].status, "pending");
});

test("补验收：停机期间执行者已交卷 → boot 直接验收翻 done", async () => {
  const dir = scratch();
  enableConfig(dir);
  const { graphId, runId } = seedInFlight(dir);
  const r = await boot(dir, {
    adapters: { fetchResult: () => ({ evidence: {} }) }, // checks 只有一条 mechanical exit 0 → 过
  });
  assert.deepEqual(r.bootReport.reattach.resubmitted, ["t-1"]);
  const st = readProjection(join(dir, "state", `${graphId}.state.json`));
  assert.equal(st.data["t-1"].status, "done");
  assert.equal(new Binder(dir).active().length, 0); // 绑定已关
});

test("在途重挂：进程死了 → 标 stalled + 上报落盘（只报不修）", async () => {
  const dir = scratch();
  enableConfig(dir);
  const { graphId } = seedInFlight(dir);
  const r = await boot(dir, { adapters: { processAlive: () => false } });
  assert.deepEqual(r.bootReport.reattach.stalled, ["t-1"]);
  const reports = readdirSync(join(dir, "reports")).filter((f) => f.includes("stalled"));
  assert.equal(reports.length, 1);
  // 状态机不动（仍 running），等人裁
  const st = readProjection(join(dir, "state", `${graphId}.state.json`));
  assert.equal(st.data["t-1"].status, "running");
});

test("单写者红线：锁被持有时第二个 boot 被拒（engine-lock-held）", async () => {
  const dir = scratch();
  enableConfig(dir);
  const first = await boot(dir);
  assert.equal(first.disabled, false);
  await assert.rejects(() => boot(dir), (e) => e.code === "engine-lock-held");
  first.lock.release();
});

test("meta 损坏 → 拒绝启动（不猜生命周期，deregistered 不许诈尸）", async () => {
  const dir = scratch();
  enableConfig(dir);
  const { graphId } = seedInFlight(dir);
  writeFileSync(join(dir, "graphs", graphId, "meta.json"), "{oops");
  await assert.rejects(() => boot(dir), (e) => e instanceof BootRefusedError && /拒绝猜生命周期/.test(e.message));
});

test("rebuildProjection 重放规则：accept/reject/blocked/失败回滚各归其位", () => {
  const g = graph();
  const evs = [
    { kind: "ready", tasks: ["t-1"] },
    { kind: "dispatch", taskId: "t-1", runId: "r-1" },
    { kind: "reject", taskId: "t-1", runId: "r-1" }, // 打回：保持 running
    { kind: "accept", taskId: "t-1", runId: "r-1" }, // 后验收过
    { kind: "ready", tasks: ["t-2"] },
    { kind: "dispatch", taskId: "t-2", runId: "r-2" },
    { kind: "blocked", taskId: "t-2", runId: "r-2", reason: "等外部" },
  ];
  const map = rebuildProjection(g, evs);
  assert.equal(map["t-1"].status, "done");
  assert.equal(map["t-2"].status, "blocked");
});
