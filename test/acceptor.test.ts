// acceptor 单元测试（S1 工作项 #7，覆盖 FR-6 / AC-6.1 及 IF-3 语义）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Acceptor, EvidenceInsufficientError, NotRunningError } from "../src/acceptor/acceptor.ts";
import { Binder, StaleRunError } from "../src/binder/binder.ts";
import { readProjection, casWriteProjection } from "../src/persister/projection-store.ts";

function scratch() {
  return mkdtempSync(join(tmpdir(), "tm-accept-"));
}

const graph = {
  apiVersion: "taskmaster/v1",
  tasks: [
    {
      id: "t-1",
      statement: "建表",
      deps: [],
      checks: [
        { text: "schema 文件存在", verify: "mechanical", file: "db/schema.sql" },
        "表结构评审过", // human：要证据
      ],
    },
  ],
};

/** 造一个 running 在途：状态 running + 活跃绑定 */
function seedRunning(dir, taskId = "t-1") {
  const p = join(dir, "state/g-1.state.json");
  const proj = readProjection(p);
  const binder = new Binder(dir);
  const binding = binder.open({ graphId: "g-1", graphVersion: 1, taskId, sessionId: "s-1", channel: "spawn" });
  casWriteProjection(p, proj.version, { ...(proj.data ?? {}), [taskId]: { status: "running", runId: binding.runId } });
  return { binder, runId: binding.runId };
}

test("AC-6.1：证据缺失 → 打回，状态不变，经 sessionId 通知执行者", async () => {
  const dir = scratch();
  const { runId } = seedRunning(dir);
  const notified: any[] = [];
  const a = new Acceptor(dir, {
    binder: new Binder(dir),
    cwd: dir,
    notifier: async (sessionId, msg) => notified.push({ sessionId, msg }),
  });
  // 不交任何证据（mechanical 的文件也不存在）
  await assert.rejects(
    () => a.submit({ graphId: "g-1", graph, taskId: "t-1", runId, evidence: {} }),
    (e) => e instanceof EvidenceInsufficientError && e.missing.length === 2,
  );
  // 状态保持 running
  const st = readProjection(join(dir, "state/g-1.state.json"));
  assert.equal(st.data["t-1"].status, "running");
  // 打回通知经绑定 sessionId 寻址
  assert.equal(notified.length, 1);
  assert.equal(notified[0].sessionId, "s-1");
  assert.match(notified[0].msg, /缺证据/);
});

test("验收通过：机械核验过 + human 有证据 → done + 关绑定 + accept 事件", async () => {
  const dir = scratch();
  const { runId } = seedRunning(dir);
  mkdirSync(join(dir, "db"), { recursive: true });
  writeFileSync(join(dir, "db/schema.sql"), "CREATE TABLE t();");
  const a = new Acceptor(dir, { binder: new Binder(dir), cwd: dir });
  const r = await a.submit({ graphId: "g-1", graph, taskId: "t-1", runId, evidence: { 1: "评审记录见 review.md" } });
  assert.equal(r.accepted, true);
  const st = readProjection(join(dir, "state/g-1.state.json"));
  assert.equal(st.data["t-1"].status, "done");
  const binder = new Binder(dir);
  assert.equal(binder.active().length, 0); // 绑定已关
});

test("机械核验白名单：file 存在性 / command 退出码；白名单外形式判不过", async () => {
  const dir = scratch();
  const { runId } = seedRunning(dir);
  const cmdGraph = {
    apiVersion: "taskmaster/v1",
    tasks: [{ id: "t-1", statement: "x", deps: [], checks: [{ text: "单测过", verify: "mechanical", command: "exit 0" }] }],
  };
  const a = new Acceptor(dir, { binder: new Binder(dir), cwd: dir });
  const r = await a.submit({ graphId: "g-1", graph: cmdGraph, taskId: "t-1", runId, evidence: {} });
  assert.equal(r.accepted, true);

  // 命令失败 → 打回
  const dir2 = scratch();
  const { runId: runId2 } = seedRunning(dir2);
  const badGraph = {
    apiVersion: "taskmaster/v1",
    tasks: [{ id: "t-1", statement: "x", deps: [], checks: [{ text: "单测过", verify: "mechanical", command: "exit 1" }] }],
  };
  const a2 = new Acceptor(dir2, { binder: new Binder(dir2), cwd: dir2 });
  await assert.rejects(
    () => a2.submit({ graphId: "g-1", graph: badGraph, taskId: "t-1", runId: runId2, evidence: {} }),
    /机械核验未通过/,
  );
});

test("世代失效：人裁重派后，旧 runId 交卷 → stale-run", async () => {
  const dir = scratch();
  const { runId } = seedRunning(dir);
  const binder = new Binder(dir);
  // 人裁重派：旧绑定作废，新绑定签发新世代，投影指向新 runId
  binder.supersede("t-1", { reason: "人裁" });
  const fresh = binder.open({ graphId: "g-1", graphVersion: 1, taskId: "t-1", sessionId: "s-2", channel: "spawn" });
  const p = join(dir, "state/g-1.state.json");
  const proj = readProjection(p);
  casWriteProjection(p, proj.version, { ...proj.data, "t-1": { ...proj.data["t-1"], runId: fresh.runId } });

  const a = new Acceptor(dir, { binder, cwd: dir });
  await assert.rejects(
    () => a.submit({ graphId: "g-1", graph, taskId: "t-1", runId, evidence: { 1: "x" } }),
    StaleRunError,
  );
});

test("幂等：已 done 的同世代重复交卷 → 幂等返回，不重复级联", async () => {
  const dir = scratch();
  const { runId } = seedRunning(dir);
  const g = { apiVersion: "taskmaster/v1", tasks: [{ id: "t-1", statement: "x", deps: [], checks: [{ text: "c", verify: "mechanical", command: "exit 0" }] }] };
  const a = new Acceptor(dir, { binder: new Binder(dir), cwd: dir });
  await a.submit({ graphId: "g-1", graph: g, taskId: "t-1", runId, evidence: {} });
  const again = await a.submit({ graphId: "g-1", graph: g, taskId: "t-1", runId, evidence: {} });
  assert.equal(again.idempotent, true);
});

test("非 running 交卷 → not-running", async () => {
  const dir = scratch();
  const binder = new Binder(dir);
  const binding = binder.open({ graphId: "g-1", graphVersion: 1, taskId: "t-1", sessionId: "s-1", channel: "spawn" });
  // 状态是 dispatching（还没 running）
  const p = join(dir, "state/g-1.state.json");
  const proj = readProjection(p);
  casWriteProjection(p, proj.version, { "t-1": { status: "dispatching" } });
  const a = new Acceptor(dir, { binder, cwd: dir });
  await assert.rejects(
    () => a.submit({ graphId: "g-1", graph, taskId: "t-1", runId: binding.runId, evidence: {} }),
    NotRunningError,
  );
});

test("blocked：状态翻 blocked + reports/ 上报落盘，引擎零自动动作", async () => {
  const dir = scratch();
  const { runId } = seedRunning(dir);
  const a = new Acceptor(dir, { binder: new Binder(dir), cwd: dir });
  const r = await a.reportBlocked({ graphId: "g-1", taskId: "t-1", runId, reason: "依赖的外部接口未就绪" });
  assert.equal(r.reported, true);
  const st = readProjection(join(dir, "state/g-1.state.json"));
  assert.equal(st.data["t-1"].status, "blocked");
  // 绑定仍在（在途，等人裁）
  assert.equal(new Binder(dir).active().length, 1);
  // 上报文件
  const reports = readdirSync(join(dir, "reports")).filter((f) => f.includes("blocked"));
  assert.equal(reports.length, 1);
});

test("打回通知失败不得吞掉 evidence-insufficient（通知是尽力而为）", async () => {
  const dir = scratch();
  const { runId } = seedRunning(dir);
  const a = new Acceptor(dir, {
    binder: new Binder(dir),
    cwd: dir,
    notifier: async () => {
      throw new TypeError("sendMessage contract broke");
    },
  });
  await assert.rejects(
    () => a.submit({ graphId: "g-1", graph, taskId: "t-1", runId, evidence: {} }),
    (e) => e instanceof EvidenceInsufficientError && e.code === "evidence-insufficient",
  );
});

test("机械核验基准目录：submit 传 cwd 时在该目录执行（宿主进程 cwd 不是工作区）", async () => {
  const dir = scratch();
  const { runId } = seedRunning(dir);
  const ws = scratch();
  writeFileSync(join(ws, "marker"), "x");
  const graph = {
    apiVersion: "taskmaster/v1",
    tasks: [{ id: "t-1", statement: "x", deps: [], checks: [{ text: "标记文件在", verify: "mechanical", command: "test -f marker" }] }],
  };
  // 默认 cwd（dir）里没有 marker → 不传 cwd 必须打回
  const a1 = new Acceptor(dir, { binder: new Binder(dir), cwd: dir });
  await assert.rejects(
    () => a1.submit({ graphId: "g-1", graph, taskId: "t-1", runId, evidence: {} }),
    /机械核验未通过/,
  );
  // 传执行者工作目录 → 通过
  const a2 = new Acceptor(dir, { binder: new Binder(dir), cwd: dir });
  const r = await a2.submit({ graphId: "g-1", graph, taskId: "t-1", runId, evidence: {}, cwd: ws });
  assert.equal(r.accepted, true);
});
