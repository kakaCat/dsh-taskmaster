// reconciler 单元测试（S1 工作项 #9，覆盖 FR-8 / AC-8.1/8.2 及图状态分流）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../src/graph-store/graph-store.js";
import { Binder } from "../src/binder/binder.js";
import { Gate } from "../src/gate/gate.js";
import { Deliverer } from "../src/deliverer/deliverer.js";
import { Monitor } from "../src/monitor/monitor.js";
import { Reconciler } from "../src/reconciler/reconciler.js";
import { readProjection, casWriteProjection } from "../src/persister/projection-store.js";

function scratch() {
  return mkdtempSync(join(tmpdir(), "tm-recon-"));
}

const chainGraph = () => ({
  apiVersion: "taskmaster/v1",
  tasks: [
    { id: "t-1", statement: "建表", deps: [], checks: [{ text: "表落库", verify: "mechanical", command: "exit 0" }] },
    { id: "t-2", statement: "接口", deps: ["t-1"], checks: ["联调过"] },
    { id: "t-3", statement: "测试", deps: ["t-2"], checks: ["全绿"] },
  ],
});

/** 装配一套模块 + 注册图；fakeChannels 注入假通道 */
function setup({ channels = {}, autoFacets = [] } = {}) {
  const dir = scratch();
  const store = new GraphStore(dir);
  const binder = new Binder(dir);
  const gate = new Gate(dir);
  const deliverer = new Deliverer(dir, { channels, binder });
  const monitor = new Monitor(dir, { binder, adapters: { activityOf: () => 0 } });
  const reconciler = new Reconciler(dir, { store, binder, gate, deliverer, monitor, autoFacets });
  const { graphId } = store.upsert(chainGraph());
  return { dir, store, binder, gate, reconciler, graphId };
}

const okSpawn = () => async () => ({ sessionId: `s-${Math.random().toString(36).slice(2, 8)}` });

test("AC-8.1：注册图后零工具调用，一拍内自动出计划卡", async () => {
  const { reconciler, gate, graphId } = setup();
  const s = await reconciler.reconcileGraph(graphId);
  assert.ok(s.actions.some((a) => a.startsWith("plan-offered")));
  assert.equal(gate.current(graphId).state, "pending");
  assert.equal(gate.current(graphId).batch[0].taskId, "t-1");
  // 下一拍：卡在等人，不重复出卡不派发
  const s2 = await reconciler.reconcileGraph(graphId);
  assert.equal(s2.actions.length, 0);
});

test("确认后下一拍自动补投递：confirmed → delivered → running + 绑定", async () => {
  const { dir, reconciler, gate, graphId } = setup({ channels: { spawn: okSpawn() } });
  await reconciler.reconcileGraph(graphId);
  const card = gate.current(graphId);
  gate.confirm(graphId, card.planId, card.readyHash);
  // 模拟：confirm 与投递之间崩溃（什么都没发生），下一拍对账补上
  const s = await reconciler.reconcileGraph(graphId);
  assert.ok(s.actions.some((a) => a.startsWith("delivered:t-1")));
  const st = readProjection(join(dir, "state", `${graphId}.state.json`));
  assert.equal(st.data["t-1"].status, "running");
  assert.equal(new Binder(dir).byGraph(graphId).length, 1);
});

test("gate=auto：一拍内无人直接派发", async () => {
  const g = chainGraph();
  g.tasks[0].milestone = "m-auto";
  const dir = scratch();
  const store = new GraphStore(dir);
  const binder = new Binder(dir);
  const reconciler = new Reconciler(dir, {
    store,
    binder,
    gate: new Gate(dir),
    deliverer: new Deliverer(dir, { channels: { spawn: okSpawn() }, binder }),
    monitor: new Monitor(dir, { binder, adapters: {} }),
    autoFacets: ["m-auto"],
  });
  const { graphId } = store.upsert(g);
  const s = await reconciler.reconcileGraph(graphId);
  assert.ok(s.actions.some((a) => a.startsWith("delivered:t-1")));
});

test("AC-8.2 姊妹篇：崩溃在投递中途（dispatching 无绑定）→ 下一拍回 ready 重出卡", async () => {
  const { dir, reconciler, gate, graphId } = setup({ channels: { spawn: okSpawn() } });
  await reconciler.reconcileGraph(graphId);
  // 手工埋一个崩溃现场：t-1 dispatching 但无绑定
  const p = join(dir, "state", `${graphId}.state.json`);
  const proj = readProjection(p);
  casWriteProjection(p, proj.version, { ...proj.data, "t-1": { status: "dispatching" } });
  // 计划卡被驳回侧忽略：直接清卡模拟"卡随崩溃失效"，由对账重出
  const s = await reconciler.reconcileGraph(graphId);
  assert.ok(s.actions.some((a) => a.startsWith("reset-dispatching:t-1")));
  // pending 卡还在 → 等人；任务已回 ready
  const st = readProjection(p);
  assert.equal(st.data["t-1"].status, "ready");
});

test("漂移修复：done 但绑定开着 → 补关绑定（对账收账），同拍级联解锁出下一批卡", async () => {
  const { dir, reconciler, binder, graphId } = setup();
  // 埋漂移：t-1 done 但绑定活跃（经同一个 binder 实例——生产上引擎也只有一本账）
  binder.open({ graphId, graphVersion: 1, taskId: "t-1", sessionId: "s-1", channel: "spawn" });
  const p = join(dir, "state", `${graphId}.state.json`);
  casWriteProjection(p, 0, { "t-1": { status: "done", runId: "r-x" } });
  const s = await reconciler.reconcileGraph(graphId);
  assert.ok(s.actions.some((a) => a === "close-binding:t-1"));
  assert.ok(s.actions.some((a) => a.startsWith("plan-offered"))); // 级联：t-2 的卡
  assert.equal(new Binder(dir).byGraph(graphId).length, 0);
});

test("paused：有就绪也不出卡，探活照做", async () => {
  const { store, reconciler, graphId } = setup();
  store.setLifecycle(graphId, "paused");
  const s = await reconciler.reconcileGraph(graphId);
  assert.equal(s.actions.length, 0);
  assert.equal(s.lifecycle, "paused");
});

test("stopping：在途清零 → stopped；之后拍跳过派发", async () => {
  const { store, reconciler, graphId } = setup();
  store.setLifecycle(graphId, "stopping");
  const s = await reconciler.reconcileGraph(graphId);
  assert.ok(s.actions.includes("stopped"));
  assert.equal(store.meta(graphId).lifecycle, "stopped");
});

test("全 done → asleep，之后拍跳过", async () => {
  const { dir, store, reconciler, graphId } = setup();
  const p = join(dir, "state", `${graphId}.state.json`);
  casWriteProjection(p, 0, {
    "t-1": { status: "done" },
    "t-2": { status: "done" },
    "t-3": { status: "done" },
  });
  const s = await reconciler.reconcileGraph(graphId);
  assert.ok(s.actions.includes("asleep"));
  const s2 = await reconciler.reconcileGraph(graphId);
  assert.equal(s2.skipped, true);
});

test("reconcileAll：多图各自对账互不影响（暂停图跳过派发，活跃图出卡）", async () => {
  const dir = scratch();
  const store = new GraphStore(dir);
  const binder = new Binder(dir);
  const reconciler = new Reconciler(dir, {
    store,
    binder,
    gate: new Gate(dir),
    deliverer: new Deliverer(dir, { channels: {}, binder }),
    monitor: new Monitor(dir, { binder, adapters: {} }),
  });
  const a = store.upsert(chainGraph());
  const b = store.upsert(chainGraph());
  store.setLifecycle(b.graphId, "paused");
  const summaries = await reconciler.reconcileAll();
  const sa = summaries.find((s) => s.graphId === a.graphId);
  const sb = summaries.find((s) => s.graphId === b.graphId);
  assert.ok(sa.actions.some((x) => x.startsWith("plan-offered")));
  assert.equal(sb.actions.length, 0); // paused：零派发动作
});
