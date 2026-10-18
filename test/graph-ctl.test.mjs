// graph-ctl 单元测试（S1 工作项 #10，覆盖 FR-11/12/13 / AC-11.1/12.1/13.1 及 IF-5）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore, BadTransitionError } from "../src/graph-store/graph-store.js";
import { Binder } from "../src/binder/binder.js";
import { GraphCtl, ConfirmRequiredError } from "../src/lifecycle/graph-ctl.js";

function scratch() {
  return mkdtempSync(join(tmpdir(), "tm-ctl-"));
}

const graph = () => ({
  apiVersion: "taskmaster/v1",
  tasks: [{ id: "t-1", statement: "建表", deps: [], checks: ["x"] }],
});

function setup() {
  const dir = scratch();
  const store = new GraphStore(dir);
  const binder = new Binder(dir);
  const ctl = new GraphCtl(dir, { store, binder });
  const { graphId } = store.upsert(graph());
  return { dir, store, binder, ctl, graphId };
}

test("暂停/恢复：active ⇄ paused，actor 落事件留痕", () => {
  const { store, ctl, graphId } = setup();
  ctl.pause(graphId, { actor: "owner-window-1" });
  assert.equal(store.meta(graphId).lifecycle, "paused");
  ctl.resume(graphId, { actor: "owner-window-1" });
  assert.equal(store.meta(graphId).lifecycle, "active");
  const events = store.eventLog(graphId).readAll();
  assert.equal(events.find((e) => e.kind === "graph-paused").actor, "owner-window-1");
});

test("停止：active/paused → stopping；非法迁移（asleep→active）被拒", () => {
  const { store, ctl, graphId } = setup();
  ctl.stop(graphId, { actor: "owner" });
  assert.equal(store.meta(graphId).lifecycle, "stopping");
  assert.throws(() => ctl.resume(graphId, { actor: "owner" }), BadTransitionError); // stopping→active 非法
});

test("注销：不带 confirm → confirm-required，零变化", () => {
  const { store, ctl, graphId } = setup();
  assert.throws(() => ctl.deregister(graphId, { actor: "owner" }), (e) => e instanceof ConfirmRequiredError && e.code === "confirm-required");
  assert.equal(store.meta(graphId).lifecycle, "active"); // 零变化
});

test("AC-13.1：注销后心跳跳过（deregistered）、历史可查、无恢复入口", () => {
  const { store, ctl, graphId } = setup();
  ctl.deregister(graphId, { actor: "owner", confirm: true });
  assert.equal(store.meta(graphId).lifecycle, "deregistered");
  // 历史全留：图版本与事件流可读
  assert.equal(store.get(graphId).tasks.length, 1);
  assert.ok(store.eventLog(graphId).readAll().length > 0);
  // 不可逆：deregistered 无任何出边
  assert.throws(() => ctl.resume(graphId, { actor: "owner" }), BadTransitionError);
  assert.throws(() => store.setLifecycle(graphId, "active"), BadTransitionError);
});

test("注销时在途绑定按失联处置：逐条关闭 + 上报落盘", () => {
  const { dir, binder, ctl, graphId } = setup();
  binder.open({ graphId, graphVersion: 1, taskId: "t-1", sessionId: "s-1", channel: "spawn" });
  const r = ctl.deregister(graphId, { actor: "owner", confirm: true });
  assert.deepEqual(r.abandoned, ["t-1"]);
  assert.equal(binder.active().length, 0);
  const reports = readdirSync(join(dir, "reports")).filter((f) => f.includes("abandoned"));
  assert.equal(reports.length, 1);
});

test("推荐路径不强制：停止后可注销（stopped→deregistered），运行中也可直接注销", () => {
  const { store, ctl, graphId } = setup();
  ctl.stop(graphId, { actor: "owner" });
  store.setLifecycle(graphId, "stopped"); // 模拟 reconciler 收口
  ctl.deregister(graphId, { actor: "owner", confirm: true });
  assert.equal(store.meta(graphId).lifecycle, "deregistered");
});
