// guard 单元测试（S1 工作项 #13，覆盖 NFR-3：开关 + 降级）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineGuard } from "../src/engine/guard.ts";
import { GraphStore } from "../src/graph-store/graph-store.ts";
import { Binder } from "../src/binder/binder.ts";
import { Gate } from "../src/gate/gate.ts";
import { Deliverer } from "../src/deliverer/deliverer.ts";
import { Monitor } from "../src/monitor/monitor.ts";
import { Reconciler } from "../src/reconciler/reconciler.ts";

function scratch() {
  return mkdtempSync(join(tmpdir(), "tm-guard-"));
}

const graph = () => ({
  apiVersion: "taskmaster/v1",
  tasks: [{ id: "t-1", statement: "建表", deps: [], checks: ["x"] }],
});

function setup({ enabled = true, channels = {} } = {}) {
  const dir = scratch();
  writeFileSync(join(dir, "config.yaml"), `enabled: ${enabled}`);
  const store = new GraphStore(dir);
  const binder = new Binder(dir);
  const gate = new Gate(dir);
  const guard = new EngineGuard(dir);
  const deliverer = new Deliverer(dir, { channels, binder });
  const monitor = new Monitor(dir, { binder, adapters: {} });
  const reconciler = new Reconciler(dir, { store, binder, gate, deliverer, monitor, guard });
  const { graphId } = store.upsert(graph());
  return { dir, store, binder, gate, guard, reconciler, graphId };
}

test("R-12：enabled=false → 零派发零探活零出卡；读写照常", async () => {
  const { store, reconciler, graphId } = setup({ enabled: false });
  const s = await reconciler.reconcileGraph(graphId);
  assert.deepEqual(s.actions, ["disabled-skip"]);
  // 读写照常：改图不受 guard 管辖
  const g = graph();
  g.tasks[0].statement = "建表 v2";
  const r = store.upsert(g, { graphId });
  assert.equal(r.version, 2);
});

test("运行中改配置：关开关下一拍生效，开回来再下一拍恢复", async () => {
  const { dir, gate, reconciler, graphId } = setup({ enabled: true });
  const s1 = await reconciler.reconcileGraph(graphId);
  assert.ok(s1.actions.some((a) => a.startsWith("plan-offered")));
  // 人关开关
  writeFileSync(join(dir, "config.yaml"), "enabled: false");
  const s2 = await reconciler.reconcileGraph(graphId);
  assert.deepEqual(s2.actions, ["disabled-skip"]);
  // 再开回来
  writeFileSync(join(dir, "config.yaml"), "enabled: true");
  const s3 = await reconciler.reconcileGraph(graphId);
  assert.deepEqual(s3.actions, []); // 卡已出过（pending），等确认，无新动作
  assert.equal(gate.current(graphId).state, "pending");
});

test("降级：全通道挂 → 标 degraded；下一拍只出卡不派送（纯对话流）", async () => {
  const fail = async () => {
    throw new Error("down");
  };
  const { gate, guard, reconciler, graphId } = setup({
    enabled: true,
    channels: { spawn: fail },
  });
  // 第一拍：出卡（pending，无人确认就不派送——降级发生在 confirmed/auto 路径）
  await reconciler.reconcileGraph(graphId);
  const card = gate.current(graphId);
  // 人确认 → 下一拍补投递 → 全通道挂 → delivery-failed + degraded
  gate.confirm(graphId, card.planId, card.readyHash);
  const s2 = await reconciler.reconcileGraph(graphId);
  assert.ok(s2.actions.some((a) => a.startsWith("delivery-failed")));
  assert.equal(guard.degraded, true);
  // 第三拍：降级中 → 不再撞通道
  const s3 = await reconciler.reconcileGraph(graphId);
  assert.ok(s3.actions.includes("dispatch-skipped-degraded"));
  // 人修好执行面 → 清标记 → 下一拍恢复
  guard.clearDegraded();
  assert.equal(guard.allowDispatch(), true);
});

test("许可分离：降级只拦派发，探活照跑", async () => {
  const { guard } = setup({ enabled: true });
  guard.markDegraded("test");
  assert.equal(guard.allowDispatch(), false);
  assert.equal(guard.allowMonitor(), true);
});
