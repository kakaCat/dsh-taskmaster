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
  const state: any = { beat: null, spawnCalls: [] as any[], notifications: [] as any[] };
  const ctx = {
    tools: { register: (t) => tools.set(t.name, t) },
    on: (ev, cb) => {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev)!.push(cb);
      return () => {};
    },
    emit: (ev, info) => (listeners.get(ev) ?? []).forEach((cb) => cb(info)),
    setInterval: (fn) => {
      state.beat = fn;
      return () => {};
    },
    get: (name) => (name === "agents" ? agents : undefined),
    subagents: {
      async startActivation(spec) {
        const id = `child-${state.spawnCalls.length + 1}`;
        state.spawnCalls.push({ provider: spec.provider, prompt: spec.request.prompt });
        agents.set(id, { session: { id } }); // 子 agent 进场（live）
        return { childId: id };
      },
      async sendMessage(parent, targetId, content) {
        state.notifications.push({ targetId, content });
      },
    },
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

test("宿主装配：工具注册 + 心跳 + spawn 派发 + subagent/end 收卷全链路", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "config.yaml"), "enabled: true\nbeatMs: 1000");
  const { ctx, tools, agents, state } = mockHost(dir);
  const owner = { session: { id: "owner-w1" } };
  agents.set("owner-w1", owner); // 属主窗口的 live agent（live parent 约束）

  await apply(ctx, { dataRoot: dir });

  // 工具注册齐全
  for (const name of ["tm_upsert", "tm_confirm", "tm_node_update", "tm_status", "tm_graph_ctl", "tm_task_action"]) {
    assert.ok(tools.has(name), `缺工具 ${name}`);
  }
  assert.ok(state.beat); // 心跳定时器已挂

  // ① 属主注册图（ownerSessionId 记入 meta）
  const reg = await tools.get("tm_upsert").execute({ graphYaml: graph() }, { agent: owner });
  assert.equal(reg.ok, true);
  const gid = reg.graphId;

  // ② 心跳一拍：出卡
  await state.beat();
  let v = (await tools.get("tm_status").execute({ graphId: gid }, {})).view;
  assert.equal(v.plan.state, "pending");

  // ③ 确认 → 下一拍：spawn 通道真派发（live parent = 属主 agent）
  await tools.get("tm_confirm").execute({ graphId: gid, planId: v.plan.planId }, { agent: owner });
  await state.beat();
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

  // ⑤ 级联：下一拍出 t-2 的卡
  await state.beat();
  v = (await tools.get("tm_status").execute({ graphId: gid }, {})).view;
  assert.equal(v.plan?.state, "pending");
  assert.equal(v.plan.batch[0].taskId, "t-2");
});

test("live parent 约束：属主不在场 → spawn 档抛错降级（全挂则回滚+降级）", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "config.yaml"), "enabled: true\nbeatMs: 1000");
  const { ctx, tools, agents, state } = mockHost(dir);
  const owner = { session: { id: "owner-w1" } };
  // 注意：owner 不在 agents 注册表 = 属主窗口已关
  await apply(ctx, { dataRoot: dir });
  const reg = await tools.get("tm_upsert").execute({ graphYaml: graph() }, { agent: owner });
  await state.beat();
  const v = (await tools.get("tm_status").execute({ graphId: reg.graphId })).view;
  await tools.get("tm_confirm").execute({ graphId: reg.graphId, planId: v.plan.planId }, { agent: owner });
  const s = await state.beat(); // mock beat 返回 reconciler promise
  // spawn/startActivation 档抛 no live owner agent → 全挂 → delivery-failed + 降级
  assert.equal(state.spawnCalls.length, 0);
  const reports = (await import("node:fs")).readdirSync(join(dir, "runs", "failed"));
  assert.equal(reports.length, 1);
});

test("enabled=false：工具注册但零心跳零订阅", async () => {
  const dir = scratch(); // 无 config = 默认关
  const { ctx, tools, state } = mockHost(dir);
  await apply(ctx, { dataRoot: dir });
  assert.ok(tools.has("tm_status")); // 读写照常
  assert.equal(state.beat, null); // 零心跳
});
