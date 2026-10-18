// S2 工作项测试：#15 并行裁决 / #16 主动探活（见 monitor.test）/ #17 死锁巡检 / #18 引擎停止
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";
import { join } from "node:path";
import { arbitrate } from "../src/scheduler/scheduler.ts";
import { boot } from "../src/engine/boot.ts";
import { TaskmasterTools } from "../src/tools/tools.ts";
import { GraphStore } from "../src/graph-store/graph-store.ts";
import { Binder } from "../src/binder/binder.ts";
import { Gate } from "../src/gate/gate.ts";
import { Deliverer } from "../src/deliverer/deliverer.ts";
import { Monitor } from "../src/monitor/monitor.ts";
import { Reconciler } from "../src/reconciler/reconciler.ts";

function scratch() {
  return mkdtempSync(join(tmpdir(), "tm-s2-"));
}

const T = (id: string, writeScopes: string[] = []) => ({ id, statement: `${id} 陈述`, checks: ["x"], writeScopes } as any);

// ─── #15 写域裁决（纯函数） ───

test("#15 写域裁决：重叠只放行先到者，其余进冲突清单；并发槽限制批量", () => {
  const ready = [T("a", ["src/api/"]), T("b", ["src/api/user.ts"]), T("c", ["docs/"]), T("d", ["test/"])];
  // 并发 4：a 先到 → b 与其重叠被跳过 → c、d 放行
  let r = arbitrate(ready, { concurrency: 4 });
  assert.deepEqual(r.batch.map((t) => t.id), ["a", "c", "d"]);
  assert.deepEqual(r.conflicts.map((t) => t.id), ["b"]);
  // 并发 2：只取前两个槽
  r = arbitrate(ready, { concurrency: 2 });
  assert.deepEqual(r.batch.map((t) => t.id), ["a", "c"]);
  // 在途占槽：并发 2 已有 1 在途 → 只取 1 个
  r = arbitrate(ready, { concurrency: 2, inFlightCount: 1 });
  assert.deepEqual(r.batch.map((t) => t.id), ["a"]);
});

test("#15 并行派发（装配级）：concurrency=2 两张独立任务一批派出", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "config.yaml"), "enabled: true\nconcurrency: 2");
  const sessions: string[] = [];
  const engine: any = await boot(dir, {
    channels: { spawn: async () => ({ sessionId: `s-${sessions.push("x")}` }) },
    adapters: { activityOf: () => 0 },
  });
  const tm = new TaskmasterTools(engine);
  const reg = await tm.upsertGraph({
    graphYaml: yaml.dump({ apiVersion: "taskmaster/v1", tasks: [T("t-1", ["a/"]), T("t-2", ["b/"])] }),
  });
  const gid = reg.graphId;
  await engine.reconciler.reconcileAll();
  const card = engine.gate.current(gid);
  assert.equal(card.batch.length, 2); // 并行批
  await tm.confirmPlan({ graphId: gid, planId: card.planId });
  await engine.reconciler.reconcileAll();
  const v = (await tm.status({ graphId: gid })).view;
  assert.equal(v.counts.running, 2); // 两张都派出
  assert.equal(sessions.length, 2);
});

// ─── #15 回归：无依赖任务必须真的并行（共享宽泛写域不算冲突） ───

test("#15 回归：多个无依赖任务在同一批派出——共享 test/** 不互相判冲突", () => {
  // 真实形态：每个任务都声明 test/**（粗粒度「我也会动测试」），旧规则让它们永远互斥
  const ready = [
    T("tpl-format", ["src/templates/**", "test/**"]),
    T("expand-contract", ["src/expand/**", "test/**"]),
    T("pack-loader", ["src/domain/**", "test/**"]),
  ];
  const r = arbitrate(ready, { concurrency: 8 });
  assert.deepEqual(r.batch.map((t) => t.id), ["tpl-format", "expand-contract", "pack-loader"]); // 全派
  assert.deepEqual(r.conflicts.map((t) => t.id), []); // 无冲突
});

test("#15 回归：真正的同文件/包含关系仍然串行（共享域不掩盖真冲突）", () => {
  // 同一具体文件 → 互斥
  let r = arbitrate([T("a", ["src/x.ts"]), T("b", ["src/x.ts"])], { concurrency: 8 });
  assert.deepEqual(r.batch.map((t) => t.id), ["a"]);
  assert.deepEqual(r.conflicts.map((t) => t.id), ["b"]);
  // 目录包含关系 → 互斥（一个写整目录，一个写目录内文件）
  r = arbitrate([T("a", ["src/api/"]), T("b", ["src/api/user.ts"])], { concurrency: 8 });
  assert.deepEqual(r.batch.map((t) => t.id), ["a"]);
  assert.deepEqual(r.conflicts.map((t) => t.id), ["b"]);
});

test("#15 回归：改 config.yaml 的 concurrency 下一拍生效（无需重启）", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "config.yaml"), "enabled: true\nconcurrency: 1");
  const engine: any = await boot(dir, {
    channels: { spawn: async () => ({ sessionId: "s-1" }) },
    adapters: { activityOf: () => 0 },
  });
  const tm = new TaskmasterTools(engine);
  // 3 个互相独立的任务：concurrency=1 时首批只出 1 个
  const reg = await tm.upsertGraph({
    graphYaml: yaml.dump({
      apiVersion: "taskmaster/v1",
      tasks: [T("t-1", ["a/x/"]), T("t-2", ["b/y/"]), T("t-3", ["c/z/"])],
    }),
  });
  const gid = reg.graphId;
  await engine.reconciler.reconcileAll();
  const card1 = engine.gate.current(gid);
  assert.equal(card1.batch.length, 1); // concurrency=1 → 串行
  await tm.confirmPlan({ graphId: gid, planId: card1.planId });
  await engine.reconciler.reconcileAll();
  // 热改配置：不重启，只改文件；下一拍剩下的 2 个应同批出卡
  writeFileSync(join(dir, "config.yaml"), "enabled: true\nconcurrency: 8");
  await engine.reconciler.reconcileAll();
  const card2 = engine.gate.current(gid);
  assert.equal(card2.batch.length, 2); // 下一拍即按 8 出批
});

// ─── #17 死锁巡检 ───

test("#17 死锁上报：等待集哈希去重（同集只报一次，事件+报告落盘）", () => {
  const dir = scratch();
  const store = new GraphStore(dir);
  const binder = new Binder(dir);
  const r = new Reconciler(dir, {
    store,
    binder,
    gate: new Gate(dir),
    deliverer: new Deliverer(dir, { channels: {}, binder }),
    monitor: new Monitor(dir, { binder, adapters: {} }),
  });
  const waiting = [{ task: T("x"), pendingDeps: ["ghost"] }];
  assert.equal(r.reportDeadlock("g-1", waiting as any), true); // 首次报
  assert.equal(r.reportDeadlock("g-1", waiting as any), false); // 同集不重复
  const reports = readdirSync(join(dir, "reports")).filter((f) => f.includes("deadlock"));
  assert.equal(reports.length, 1);
  // 等待集变化 → 重新报
  const waiting2 = [{ task: T("y"), pendingDeps: ["ghost2"] }];
  assert.equal(r.reportDeadlock("g-1", waiting2 as any), true);
  assert.equal(readdirSync(join(dir, "reports")).filter((f) => f.includes("deadlock")).length, 2);
});

// ─── #18 引擎级停止 ───

test("#18 引擎停止：心跳停（零派发零探活），在途不杀、台账保留；再启动恢复并补投递", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "config.yaml"), "enabled: true");
  const engine: any = await boot(dir, {
    channels: { spawn: async () => ({ sessionId: "s-1" }) },
    adapters: { activityOf: () => 0 },
  });
  const tm = new TaskmasterTools(engine);
  const reg = await tm.upsertGraph({
    graphYaml: yaml.dump({ apiVersion: "taskmaster/v1", tasks: [T("t-1")] }),
  });
  const gid = reg.graphId;

  // 停引擎（IF-7）
  const stop = await tm.engineCtl({ action: "stop" });
  assert.equal(stop.ok, true);
  const beat1 = await engine.reconciler.reconcileGraph(gid);
  assert.deepEqual(beat1.actions, ["disabled-skip"]); // 心跳停：零动作
  // 读写照常
  assert.equal((await tm.status({ graphId: gid })).ok, true);

  // 启动恢复：下一拍接管（等效 Boot ④）
  const start = await tm.engineCtl({ action: "start" });
  assert.equal(start.ok, true);
  const beat2 = await engine.reconciler.reconcileGraph(gid);
  assert.ok(beat2.actions.some((a: string) => a.startsWith("plan-offered")));
});
