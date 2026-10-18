// 宿主集成测试（mock cordis 宿主）：插件装配 → 工具面全链路 → 事件订阅收卷
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";
import { join } from "node:path";
import { apply } from "../src/host/plugin.ts";

function scratch() {
  return mkdtempSync(join(tmpdir(), "tm-host-"));
}

/** 最小 cordis 宿主 mock：tools 注册表 / 事件总线 / setInterval / agents 注册表 / subagents service
 *  契约按真宿主 dsh-subagent 收紧：provider 只能是 spawn|fork、必须带 AbortSignal、
 *  prompt 必须是 ContentBlock[]、sendMessage 的 content/options 都不能省。
 *  lateSubagents=true 时服务在 apply 后才出现（复现 cordis 服务渐进就绪）。 */
function mockHost(dir, { lateSubagents = false } = {}) {
  const tools = new Map<string, any>();
  const listeners = new Map<string, any[]>();
  const agents = new Map<string, any>();
  const state: any = { beat: null, effects: [] as any[], spawnCalls: [] as any[], notifications: [] as any[], subagentsReady: !lateSubagents };
  const subagents = {
    async startActivation(spec) {
      if (typeof spec?.signal?.throwIfAborted !== "function") throw new Error("startActivation 缺 signal");
      if (!Array.isArray(spec?.request?.prompt)) throw new Error("request.prompt 必须是 ContentBlock[]");
      if (!["spawn", "fork"].includes(spec.provider)) throw new Error(`未注册的 provider: ${spec.provider}`);
      // descriptor 无条件写 label：省略会变成 undefined 字段 → 宿主判非 lossless JSON
      if (typeof spec.label !== "string" || !spec.label) throw new Error("startActivation 缺 label（descriptor lossless 要求）");
      const id = `child-${state.spawnCalls.length + 1}`;
      state.spawnCalls.push({ provider: spec.provider, label: spec.label, prompt: spec.request.prompt, signal: spec.signal, delivery: spec.delivery });
      agents.set(id, { session: { id } });
      return { childId: id };
    },
    async sendMessage(parent, targetId, content, options) {
      if (!Array.isArray(content)) throw new Error("sendMessage content 必须是 ContentBlock[]");
      if (typeof options?.signal?.throwIfAborted !== "function") throw new Error("sendMessage 缺 options.signal");
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
    emit: (ev, ...args) => (listeners.get(ev) ?? []).forEach((cb) => cb(...args)),
    // cordis 生命周期形态：effect(fn) 执行并持有清理器；心跳走真实 setInterval，测试用轮询
    effect: (fn: any) => {
      const dispose = fn();
      state.effects.push(dispose);
      return dispose;
    },
    get: (name) => {
      if (name === "agents") return agents;
      if (name === "subagents") return state.subagentsReady ? subagents : undefined;
      return undefined;
    },
    subagents,
  };
  return { ctx, tools, agents, state, listeners };
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
  const reg = await tools.get("tm_upsert").execute({ graphYaml: yaml.dump(graph()) }, { agent: owner });
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
  // 真宿主契约：provider 用已注册名、prompt 是 ContentBlock[]、带 signal、label 是字符串
  assert.equal(state.spawnCalls[0].provider, "spawn");
  assert.ok(Array.isArray(state.spawnCalls[0].prompt));
  assert.ok(state.spawnCalls[0].signal instanceof AbortSignal);
  assert.match(state.spawnCalls[0].label, /Taskmaster /);
  const promptText = state.spawnCalls[0].prompt.map((b: any) => b.text).join("");
  // 任务包携带世代凭据 + 视野最小化（prompt 里无 t-2 的陈述）
  assert.match(promptText, /世代 r-/);
  assert.match(promptText, /建表/);
  assert.doesNotMatch(promptText, /接口/);
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
  const reg = await tools.get("tm_upsert").execute({ graphYaml: yaml.dump(graph()) }, { agent: owner });
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

test("enabled=false：零心跳零订阅，但 tm_* 读写照常可用（NFR-3）", async (t) => {
  const dir = scratch(); // 无 config = 默认关
  const { ctx, tools, state } = mockHost(dir);
  await apply(ctx, { dataRoot: dir });
  const until = async (cond: () => boolean, ms = 1500) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };
  t.after(() => state.effects.forEach((d: any) => d?.()));
  assert.ok(tools.has("tm_status")); // 工具照常注册
  assert.equal(state.effects.length, 0); // 零心跳

  // 关闭态仍可注册/查图（旧实现：engine 只有 {disabled:true}，这两个调用直接 internal 错）
  const reg = await tools.get("tm_upsert").execute(
    { graphYaml: yaml.dump({ apiVersion: "taskmaster/v1", tasks: [{ id: "t-1", statement: "x", checks: ["ok"] }] }) },
    { agent: { session: { id: "owner-off" } } },
  );
  assert.equal(reg.ok, true, JSON.stringify(reg));
  const st = await tools.get("tm_status").execute({ graphId: reg.graphId }, {});
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.equal(st.view.counts.pending, 1);
  assert.equal(st.view.engine.enabled, false);
  // 引擎级操作在关闭态如实回 no-engine
  const es = await tools.get("tm_engine_stop").execute({}, {});
  assert.equal(es.code, "no-engine");
});

test("subagents 服务迟到（apply 后才 active）：惰性解析仍能派发", async (t) => {
  const dir = scratch();
  writeFileSync(join(dir, "config.yaml"), "enabled: true\nbeatMs: 30");
  const { ctx, tools, agents, state } = mockHost(dir, { lateSubagents: true });
  const owner = { session: { id: "owner-late" } };
  agents.set("owner-late", owner);
  await apply(ctx, { dataRoot: dir }); // 此刻 ctx.get("subagents") 还是 undefined
  state.subagentsReady = true; // 服务稍后就绪
  t.after(() => state.effects.forEach((d: any) => d?.()));
  const until = async (cond: () => boolean, ms = 1500) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };

  const reg = await tools.get("tm_upsert").execute({ graphYaml: yaml.dump(graph()) }, { agent: owner });
  const gv = async () => (await tools.get("tm_status").execute({ graphId: reg.graphId })).view;
  for (let i = 0; i < 120 && !(await gv()).plan; i++) await new Promise((r) => setTimeout(r, 20));
  const v = await gv();
  await tools.get("tm_confirm").execute({ graphId: reg.graphId, planId: v.plan.planId }, { agent: owner });
  await until(() => state.spawnCalls.length > 0);
  assert.equal(state.spawnCalls.length, 1);
  assert.equal((await gv()).inFlight[0].status, "running");
});

test("活性订阅：session/event 也计入执行者活动（长任务不被误判 stalled 的前提）", async (t) => {
  const dir = scratch();
  writeFileSync(join(dir, "config.yaml"), "enabled: true\nbeatMs: 30");
  const { ctx, state, listeners } = mockHost(dir);
  await apply(ctx, { dataRoot: dir });
  t.after(() => state.effects.forEach((d: any) => d?.()));
  assert.ok(listeners.has("subagent/start"));
  assert.ok(listeners.has("subagent/end"));
  assert.ok(listeners.has("session/event"), "缺少 session/event 活性订阅");
});

test("打回通知走真契约：sendMessage(content: ContentBlock[], { signal })；打回码不被通知异常吞掉", async (t) => {
  const dir = scratch();
  writeFileSync(join(dir, "config.yaml"), "enabled: true\nbeatMs: 30");
  const { ctx, tools, agents, state } = mockHost(dir);
  const owner = { session: { id: "owner-n" } };
  agents.set("owner-n", owner);
  await apply(ctx, { dataRoot: dir });
  const until = async (cond: () => boolean, ms = 2000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };
  t.after(() => state.effects.forEach((d: any) => d?.()));

  const reg = await tools.get("tm_upsert").execute(
    {
      graphYaml: yaml.dump({
        apiVersion: "taskmaster/v1",
        tasks: [{ id: "t-1", statement: "需要证据", checks: ["人复核过"] }],
      }),
    },
    { agent: owner },
  );
  const view = async () => (await tools.get("tm_status").execute({ graphId: reg.graphId })).view;
  for (let i = 0; i < 120 && !(await view()).plan; i++) await new Promise((r) => setTimeout(r, 20));
  const card = (await view()).plan;
  await tools.get("tm_confirm").execute({ graphId: reg.graphId, planId: card.planId }, { agent: owner });
  await until(() => state.spawnCalls.length > 0);
  const runId = (await view()).inFlight[0].runId;

  const bad = await tools.get("tm_node_update").execute({ graphId: reg.graphId, taskId: "t-1", runId, evidence: {} }, {});
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "evidence-insufficient"); // 旧实现被 sendMessage 的 TypeError 替换成 internal
  assert.equal(bad.missing.length, 1);
  assert.equal(state.notifications.length, 1);
  assert.ok(Array.isArray(state.notifications[0].content));

  const good = await tools.get("tm_node_update").execute({ graphId: reg.graphId, taskId: "t-1", runId, evidence: { 0: "复核记录" } }, {});
  assert.equal(good.ok, true);
  assert.equal((await view()).counts.done, 1);
});
