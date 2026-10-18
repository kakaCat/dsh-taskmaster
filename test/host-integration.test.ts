// 宿主集成测试（mock cordis 宿主）：插件装配 → 工具面全链路 → 事件订阅收卷
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../src/host/plugin.ts";

function scratch() {
  return mkdtempSync(join(tmpdir(), "tm-host-"));
}

/** 最小 cordis 宿主 mock：tools 注册表 / 事件总线 / setInterval / agents 注册表 / subagents service */
function mockHost(dir) {
  const tools = new Map<string, any>();
  const listeners = new Map<string, any[]>();
  const agents = new Map<string, any>();
  const state: any = { beat: null, effects: [] as any[], spawnCalls: [] as any[], notifications: [] as any[] };
  const subagents = {
    async startActivation(spec) {
      const id = `child-${state.spawnCalls.length + 1}`;
      state.spawnCalls.push({ provider: spec.provider, prompt: spec.request.prompt });
      agents.set(id, { session: { id } });
      return { childId: id };
    },
    async sendMessage(parent, targetId, content) {
      state.notifications.push({ targetId, content });
    },
  };
  const ctx = {
    tools: { register: (t) => tools.set(t.name, t) },
    on: (ev, cb) => {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev)!.push(cb);
      return () => {};
    },
    emit: (ev, info) => (listeners.get(ev) ?? []).forEach((cb) => cb(info)),
    // cordis 生命周期形态：effect(fn) 执行并持有清理器；心跳走真实 setInterval，测试用轮询
    effect: (fn: any) => {
      const dispose = fn();
      state.effects.push(dispose);
      return dispose;
    },
    get: (name) => (name === "agents" ? agents : name === "subagents" ? subagents : undefined),
    subagents,
  };
  return { ctx, tools, agents, state };
}

const graph = (): any => ({
  apiVersion: "taskmaster/v1",
  tasks: [
    { id: "t-1", statement: "建表", deps: [], checks: [{ text: "表落库", verify: "mechanical", command: "exit 0" }] },
    { id: "t-2", statement: "接口", deps: ["t-1"], checks: [{ text: "联调", verify: "mechanical", command: "exit 0" }] },
  ],
});

test("宿主装配：工具注册 + 心跳 + spawn 派发 + subagent/end 收卷全链路", async (t) => {
  const dir = scratch();
  writeFileSync(join(dir, "config.yaml"), "enabled: true\nbeatMs: 30");
  const { ctx, tools, agents, state } = mockHost(dir);
  const owner = { session: { id: "owner-w1" } };
  agents.set("owner-w1", owner); // 属主窗口的 live agent（live parent 约束）

  await apply(ctx, { dataRoot: dir });
  const until = async (cond: () => boolean, ms = 1500) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };
  t.after(() => state.effects.forEach((d: any) => d?.()));

  // 工具注册齐全
  for (const name of ["tm_upsert", "tm_confirm", "tm_node_update", "tm_status", "tm_graph_ctl", "tm_task_action"]) {
    assert.ok(tools.has(name), `缺工具 ${name}`);
  }
  assert.ok(state.effects.length > 0); // 心跳 effect 已挂

  // ① 属主注册图（ownerSessionId 记入 meta）
  const reg = await tools.get("tm_upsert").execute({ graphYaml: graph() }, { agent: owner });
  assert.equal(reg.ok, true);
  const gid = reg.graphId;

  // ② 真实心跳（轮询）出卡
  const getView = async () => (await tools.get("tm_status").execute({ graphId: gid }, {})).view;
  for (let i = 0; i < 120 && !(await getView()).plan; i++) await new Promise((r) => setTimeout(r, 20));
  let v = await getView();
  assert.equal(v.plan.state, "pending");

  // ③ 确认 → 下一拍：spawn 通道真派发（live parent = 属主 agent）
  await tools.get("tm_confirm").execute({ graphId: gid, planId: v.plan.planId }, { agent: owner });
  await until(() => state.spawnCalls.length > 0);
  assert.equal(state.spawnCalls.length, 1);
  // 任务包携带世代凭据 + 视野最小化（prompt 里无 t-2 的陈述）
  assert.match(state.spawnCalls[0].prompt, /世代 r-/);
  assert.match(state.spawnCalls[0].prompt, /建表/);
  assert.doesNotMatch(state.spawnCalls[0].prompt, /接口/);
  v = (await tools.get("tm_status").execute({ graphId: gid }, {})).view;
  assert.equal(v.inFlight[0].status, "running");
  const runId = v.inFlight[0].runId;

  // ④ 执行者交卷：唯一证据渠道是 tm_node_update（真实契约：subagent/end 不带证据）
  ctx.emit("subagent/end", { local: true, id: "child-1", stopReason: "completed", lastAssistantMessage: [] });
  // end 事件只留痕不验收：任务仍 running
  v = (await tools.get("tm_status").execute({ graphId: gid }, {})).view;
  assert.ok(!v.counts.done); // undefined/0 都算未完成
  const submit = await tools.get("tm_node_update").execute(
    { graphId: gid, taskId: "t-1", runId, evidence: {} },
    {},
  );
  assert.equal(submit.ok, true);
  v = (await tools.get("tm_status").execute({ graphId: gid }, {})).view;
  assert.equal(v.counts.done, 1);

  // ⑤ 级联：下一拍出 t-2 的卡（等新的 pending 卡，旧 confirmed 卡会被顶替）
  for (let i = 0; i < 200 && (await getView()).plan?.state !== "pending"; i++) await new Promise((r) => setTimeout(r, 20));
  v = await getView();
  assert.equal(v.plan?.state, "pending");
  assert.equal(v.plan.batch[0].taskId, "t-2");
});

test("live parent 约束：属主不在场 → spawn 档抛错降级（全挂则回滚+降级）", async (t) => {
  const dir = scratch();
  writeFileSync(join(dir, "config.yaml"), "enabled: true\nbeatMs: 30");
  const { ctx, tools, agents, state } = mockHost(dir);
  const owner = { session: { id: "owner-w1" } };
  // 注意：owner 不在 agents 注册表 = 属主窗口已关
  await apply(ctx, { dataRoot: dir });
  const until = async (cond: () => boolean, ms = 1500) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };
  t.after(() => state.effects.forEach((d: any) => d?.()));
  const reg = await tools.get("tm_upsert").execute({ graphYaml: graph() }, { agent: owner });
  const gv = async () => (await tools.get("tm_status").execute({ graphId: reg.graphId })).view;
  for (let i = 0; i < 120 && !(await gv()).plan; i++) await new Promise((r) => setTimeout(r, 20));
  const v = await gv();
  await tools.get("tm_confirm").execute({ graphId: reg.graphId, planId: v.plan.planId }, { agent: owner });
  // 真实心跳跑几拍：confirmed → 补投递 → 全挂 → runs/failed 留痕
  const { existsSync } = await import("node:fs");
  for (let i = 0; i < 120 && !existsSync(join(dir, "runs", "failed")); i++) await new Promise((r) => setTimeout(r, 20));
  // spawn/startActivation 档抛 no live owner agent → 全挂 → delivery-failed + 降级
  assert.equal(state.spawnCalls.length, 0);
  const reports = (await import("node:fs")).readdirSync(join(dir, "runs", "failed"));
  assert.equal(reports.length, 1);
});

test("enabled=false：工具注册但零心跳零订阅", async (t) => {
  const dir = scratch(); // 无 config = 默认关
  const { ctx, tools, state } = mockHost(dir);
  await apply(ctx, { dataRoot: dir });
  const until = async (cond: () => boolean, ms = 1500) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };
  t.after(() => state.effects.forEach((d: any) => d?.()));
  assert.ok(tools.has("tm_status")); // 读写照常
  assert.equal(state.effects.length, 0); // 零心跳
});
