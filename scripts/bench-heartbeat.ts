// Taskmaster 心跳单拍成本 spike（调研 E-10 的可复现实测）
// 模拟 reconciler 一拍的工作：读图(YAML) + 读状态投影 + 读绑定台账 + 就绪计算 + 事件追加
// 运行：node scripts/bench-heartbeat.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// js-yaml 从宿主运行时借用（产物依赖里现成）
const require = createRequire("/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/");
const yaml = require("js-yaml");

const SIZES = [100, 500, 1000, 5000];
const BEATS = 30;

function makeGraph(n) {
  // 链式 + 扇出混合：每 10 个任务挂在前一个上，制造真实依赖深度
  const tasks: any[] = [];
  for (let i = 0; i < n; i++) {
    tasks.push({
      id: `t-${String(i).padStart(4, "0")}`,
      statement: `实现模块 ${i}：包含若干子步骤与验收判据的占位描述文本`,
      deps: i === 0 ? [] : [`t-${String(Math.floor((i - 1) / 10) * 10).padStart(4, "0")}`],
      checks: [`构建通过 ${i}`, `测试通过 ${i}`],
      writeScopes: [`src/mod-${i % 50}/`],
      roundBudget: 20,
    });
  }
  return { apiVersion: "taskmaster/v1", graphId: "bench", tasks };
}

function bench(n) {
  const root = mkdtempSync(join(tmpdir(), `tm-bench-${n}-`));
  mkdirSync(join(root, "graphs/bench"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "events"), { recursive: true });

  const graphYaml = yaml.dump(makeGraph(n));
  writeFileSync(join(root, "graphs/bench/v1.yaml"), graphYaml);
  // 一半任务 done，四分之一 running，其余 pending —— 模拟进行中快照
  const state = {};
  for (let i = 0; i < n; i++) {
    const id = `t-${String(i).padStart(4, "0")}`;
    state[id] = { status: i < n / 2 ? "done" : i < (n * 3) / 4 ? "running" : "pending", lastSeq: i };
  }
  writeFileSync(join(root, "state/bench.state.json"), JSON.stringify(state));
  writeFileSync(join(root, "bindings.json"), JSON.stringify({}));

  const t: number[] = [];
  for (let beat = 0; beat < BEATS; beat++) {
    const t0 = performance.now();
    // 1) 读图（YAML 解析是全拍最大头）
    const graph = yaml.load(readFileSync(join(root, "graphs/bench/v1.yaml"), "utf8"));
    // 2) 读状态投影 + 绑定台账
    const st = JSON.parse(readFileSync(join(root, "state/bench.state.json"), "utf8"));
    JSON.parse(readFileSync(join(root, "bindings.json"), "utf8"));
    // 3) 就绪计算：全部前驱 done → ready
    let ready = 0;
    for (const task of graph.tasks) {
      if (st[task.id].status !== "pending") continue;
      if (task.deps.every((d) => st[d]?.status === "done")) ready++;
    }
    // 4) 事件追加（对账留痕）
    appendFileSync(join(root, "events/bench.events.ndjson"), JSON.stringify({ seq: beat, kind: "reconcile", ready }) + "\n");
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  const p50 = t[Math.floor(BEATS * 0.5)];
  const p95 = t[Math.floor(BEATS * 0.95)];
  return { n, yamlKB: Math.round(graphYaml.length / 1024), p50: p50.toFixed(1), p95: p95.toFixed(1) };
}

console.log("| 任务数 | 图 YAML 体积 | 单拍 P50 (ms) | 单拍 P95 (ms) |");
console.log("|---|---|---|---|");
for (const n of SIZES) {
  const r = bench(n);
  console.log(`| ${n} | ${r.yamlKB} KB | ${r.p50} | ${r.p95} |`);
}
