// 真机 cordis 装配冒烟（S2 后联调）：用真实 cordis Context + timer 插件挂载本插件，
// 验证：插件生命周期（apply/await/注入 tools 服务）、心跳定时器（ctx.setInterval）、
// 工具注册经 cordis 服务协议、事件订阅、dispose 全量清理。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import TimerPlugin from "@deepseek-ai/cordis-plugin-timer";
import * as taskmaster from "../src/host/plugin.ts";

function scratch() {
  return mkdtempSync(join(tmpdir(), "tm-cordis-"));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("真 cordis 装配：插件挂载 → 工具注册 → 心跳出卡 → dispose 清理", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "config.yaml"), "enabled: true\nbeatMs: 50");

  // 真实 cordis root + timer 插件（提供 ctx.setInterval）
  const root = new Context();
  await root.plugin(TimerPlugin);

  // 宿主服务：tools 注册表 / subagents / agents 注册表（provide 到 root fiber）
  const tools = new Map<string, any>();
  const spawns: any[] = [];
  const agents = new Map<string, any>();
  const owner = { session: { id: "owner-cordis" } };
  agents.set("owner-cordis", owner);
  const notify: any[] = [];

  root.reflect.provide("tools", { register: (t: any) => tools.set(t.name, t) });
  root.reflect.provide("agents", { get: (id: string) => agents.get(id) });
  root.reflect.provide("subagents", {
    async startActivation(spec: any) {
      spawns.push(spec);
      const child = `child-${spawns.length}`;
      agents.set(child, { session: { id: child } });
      return { childId: child };
    },
    async sendMessage(_parent: any, targetId: string, content: string) {
      notify.push({ targetId, content });
    },
  });

  // 挂载被测插件（真实 cordis 对象插件协议：{ name, inject, Config, apply }）
  const fiber = await root.plugin(taskmaster, { dataRoot: dir } as any);

  try {
    // ① 工具经 cordis 服务协议注册
    for (const name of ["tm_upsert", "tm_confirm", "tm_node_update", "tm_status", "tm_graph_ctl", "tm_task_action", "tm_engine_stop", "tm_engine_start"]) {
      assert.ok(tools.has(name), `cordis 上缺工具 ${name}`);
    }

    // ② 注册图 → 等真实心跳（50ms/拍）出计划卡
    const reg = await tools.get("tm_upsert").execute(
      {
        graphYaml: {
          apiVersion: "taskmaster/v1",
          tasks: [{ id: "t-1", statement: "冒烟任务", deps: [], checks: [{ text: "通过", verify: "mechanical", command: "exit 0" }] }],
        },
      },
      { agent: owner },
    );
    assert.equal(reg.ok, true);
    let card: any = null;
    for (let i = 0; i < 40 && !card; i++) {
      await sleep(25);
      card = (await tools.get("tm_status").execute({ graphId: reg.graphId }, {})).view.plan;
    }
    assert.ok(card, "真实心跳未在 1s 内出计划卡");
    assert.equal(card.state, "pending");

    // ③ 确认 → 心跳派发（真 cordis 定时器驱动，spawn 经注入的 subagents 服务）
    await tools.get("tm_confirm").execute({ graphId: reg.graphId, planId: card.planId }, { agent: owner });
    for (let i = 0; i < 40 && spawns.length === 0; i++) await sleep(25);
    assert.equal(spawns.length, 1, "真实心跳未派发");
    // 任务包走真 prompt 渲染（含世代凭据与视野最小化）
    assert.match(spawns[0].request.prompt, /世代 r-/);

    // ④ 交卷（真实 socket 无，直接调工具）→ done
    const run = (await tools.get("tm_status").execute({ graphId: reg.graphId }, {})).view.inFlight[0];
    const sub = await tools.get("tm_node_update").execute({ graphId: reg.graphId, taskId: "t-1", runId: run.runId, evidence: {} }, {});
    assert.equal(sub.ok, true);
    const done = (await tools.get("tm_status").execute({ graphId: reg.graphId }, {})).view.counts.done;
    assert.equal(done, 1);
  } finally {
    // ⑤ dispose：插件卸载，定时器停止（cordis 生命周期托管）
    await (fiber as any)?.dispose?.();
    const spawnsBefore = spawns.length;
    await sleep(150); // 若定时器未停，会继续对账（图 asleep 后无动作，用新图验证更彻底）
    await root.fiber.dispose();
    assert.equal(spawns.length, spawnsBefore); // 卸载后不再派发
  }
});
