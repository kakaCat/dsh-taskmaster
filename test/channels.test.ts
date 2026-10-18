// 通道就绪探测（启动期竞态）：available/pending 判定直接影响「延迟」还是「降级」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeChannels } from "../src/host/channels.ts";

const owner = () => ({ session: { id: "owner" } });

test("服务完全未注册：启动宽限内视为 pending（可延迟，不降级）", () => {
  const ctx = { get: () => undefined, reflect: { store: {} } };
  const channels = makeChannels(ctx, owner);
  assert.equal(channels.available(), false);
  assert.equal(channels.pending(), true);
});

test("服务已注册但 fiber 尚未 active：pending", () => {
  const store: any = {};
  store[Symbol("subagents#x")] = { name: "subagents", fiber: { state: 1 } };
  const ctx = { get: () => undefined, reflect: { store } };
  const channels = makeChannels(ctx, owner);
  assert.equal(channels.available(), false);
  assert.equal(channels.pending(), true);
});

test("服务 active 且 provider 已注册：available 且非 pending", () => {
  const subagents = {
    startActivation: async () => ({ childId: "c" }),
    sendMessage: async () => "m",
    getProvider: (n: string) => (n === "spawn" ? { name: "spawn" } : undefined),
  };
  const ctx = { get: (n: string) => (n === "subagents" ? subagents : undefined), reflect: { store: {} } };
  const channels = makeChannels(ctx, owner);
  assert.equal(channels.available(), true);
  assert.equal(channels.pending(), false);
});

test("服务 active 但 provider 未注册：pending（不是降级）", () => {
  const subagents = { startActivation: async () => ({ childId: "c" }), getProvider: () => undefined };
  const ctx = { get: (n: string) => (n === "subagents" ? subagents : undefined), reflect: { store: {} } };
  const channels = makeChannels(ctx, owner);
  assert.equal(channels.available(), false);
  assert.equal(channels.pending(), true);
});
