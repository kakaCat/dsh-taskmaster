// 图校验：schema + 语义（无环）。全部校验失败零落盘，issues 逐条指向 tasks[i]。
// 对应 FR-1 / IF-1：invalid-graph 的 issues 是调用方修图的唯一指引。

const ALLOWED_API_VERSION = "taskmaster/v1";
const VERIFY_KINDS = new Set(["mechanical", "human"]);
const EXPANSION_KINDS = new Set(["atomic", "expanded"]);
const OUTPUT_KINDS = new Set(["file", "check", "value"]);
const GRAPH_KEYS = new Set(["apiVersion", "tasks"]);
const TASK_KEYS = new Set([
  "id", "statement", "deps", "checks", "writeScopes", "roundBudget", "kind", "story", "milestone",
  "expansion", "outputs",
]);
const CHECK_KEYS = new Set(["text", "verify", "file", "command"]);
const OUTPUT_KEYS = new Set(["name", "kind", "path"]);

/** 未知键报错不忽略（IF-1 兼容性约定：schema 只增字段，拼错的键必须当场暴露） */
function unknownKeys(obj: any, allowed: Set<string>, at: string, issues: any[]) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      issues.push({ target: `${at}.${key}`, reason: `未知字段 "${key}"（允许：${[...allowed].join(" / ")}）` });
    }
  }
}

export class GraphValidationError extends Error {
  code: string;
  issues: any[];
  constructor(issues) {
    super(`invalid graph (${issues.length} issue(s))`);
    this.code = "invalid-graph";
    this.issues = issues;
  }
}

/**
 * 校验图对象。@returns issues 数组（空 = 通过）；不抛异常，抛否由调用方定。
 * 每条 issue：{ target: "tasks[i].deps" 等, reason: 中文描述 }
 */
export function validateGraph(graph) {
  const issues: any[] = [];
  if (graph === null || typeof graph !== "object" || Array.isArray(graph)) {
    return [{ target: "$", reason: "图必须是一个对象" }];
  }
  if (graph.apiVersion !== ALLOWED_API_VERSION) {
    issues.push({ target: "apiVersion", reason: `必须是 "${ALLOWED_API_VERSION}"，实际为 ${JSON.stringify(graph.apiVersion)}` });
  }
  if (!Array.isArray(graph.tasks) || graph.tasks.length === 0) {
    issues.push({ target: "tasks", reason: "必须是非空任务数组" });
    return issues; // 没有任务就没法做后续校验
  }
  unknownKeys(graph, GRAPH_KEYS, "$", issues);

  const ids = new Set();
  graph.tasks.forEach((t, i) => {
    const at = `tasks[${i}]`;
    if (t === null || typeof t !== "object" || Array.isArray(t)) {
      issues.push({ target: at, reason: "任务必须是对象" });
      return;
    }
    unknownKeys(t, TASK_KEYS, at, issues);
    for (const key of ["kind", "story", "milestone"]) {
      if (t[key] !== undefined && typeof t[key] !== "string") {
        issues.push({ target: `${at}.${key}`, reason: `${key} 必须是字符串` });
      }
    }
    if (typeof t.id !== "string" || !t.id.trim()) {
      issues.push({ target: `${at}.id`, reason: "id 必须是非空字符串" });
    } else if (ids.has(t.id)) {
      issues.push({ target: `${at}.id`, reason: `任务 id "${t.id}" 重复` });
    } else {
      ids.add(t.id);
    }
    if (typeof t.statement !== "string" || !t.statement.trim()) {
      issues.push({ target: `${at}.statement`, reason: "任务陈述必须是非空字符串" });
    }
    if (!Array.isArray(t.checks) || t.checks.length === 0) {
      issues.push({ target: `${at}.checks`, reason: "验收判据必须是非空数组" });
    } else {
      t.checks.forEach((c, j) => {
        if (typeof c === "string") {
          if (!c.trim()) issues.push({ target: `${at}.checks[${j}]`, reason: "判据文本不能为空" });
        } else if (c && typeof c === "object" && typeof c.text === "string" && c.text.trim()) {
          unknownKeys(c, CHECK_KEYS, `${at}.checks[${j}]`, issues);
          if (c.verify !== undefined && !VERIFY_KINDS.has(c.verify)) {
            issues.push({ target: `${at}.checks[${j}].verify`, reason: `verify 只能是 mechanical|human，实际为 ${JSON.stringify(c.verify)}` });
          }
          for (const key of ["file", "command"]) {
            if (c[key] !== undefined && typeof c[key] !== "string") {
              issues.push({ target: `${at}.checks[${j}].${key}`, reason: `${key} 必须是字符串` });
            }
          }
        } else {
          issues.push({ target: `${at}.checks[${j}]`, reason: "判据必须是非空字符串或 { text, verify? }" });
        }
      });
    }
    if (t.deps !== undefined) {
      if (!Array.isArray(t.deps)) {
        issues.push({ target: `${at}.deps`, reason: "deps 必须是数组" });
      } else {
        t.deps.forEach((d, j) => {
          if (typeof d !== "string") {
            issues.push({ target: `${at}.deps[${j}]`, reason: "依赖必须引用任务 id 字符串" });
          } else if (d === t.id) {
            issues.push({ target: `${at}.deps[${j}]`, reason: "不允许自依赖" });
          }
        });
      }
    }
    if (t.writeScopes !== undefined && (!Array.isArray(t.writeScopes) || t.writeScopes.some((s) => typeof s !== "string"))) {
      issues.push({ target: `${at}.writeScopes`, reason: "writeScopes 必须是字符串数组" });
    }
    if (t.roundBudget !== undefined && (!Number.isSafeInteger(t.roundBudget) || t.roundBudget <= 0)) {
      issues.push({ target: `${at}.roundBudget`, reason: "roundBudget 必须是正整数" });
    }
    // 拆解粒度：缺省 = atomic（旧图无此字段，行为不变）
    if (t.expansion !== undefined && !EXPANSION_KINDS.has(t.expansion)) {
      issues.push({ target: `${at}.expansion`, reason: `expansion 只能是 atomic|expanded，实际为 ${JSON.stringify(t.expansion)}` });
    }
    // 产出承诺：边按 output.name 引用，name 必须唯一
    if (t.outputs !== undefined) {
      if (!Array.isArray(t.outputs)) {
        issues.push({ target: `${at}.outputs`, reason: "outputs 必须是数组" });
      } else {
        const seenOutputs = new Set();
        t.outputs.forEach((o, j) => {
          const oat = `${at}.outputs[${j}]`;
          if (o === null || typeof o !== "object" || Array.isArray(o)) {
            issues.push({ target: oat, reason: "产出声明必须是对象 { name, kind, path? }" });
            return;
          }
          unknownKeys(o, OUTPUT_KEYS, oat, issues);
          if (typeof o.name !== "string" || !o.name.trim()) {
            issues.push({ target: `${oat}.name`, reason: "产出名称必须是非空字符串" });
          } else if (seenOutputs.has(o.name)) {
            issues.push({ target: `${oat}.name`, reason: `产出名称 "${o.name}" 重复（边按 name 引用，必须唯一）` });
          } else {
            seenOutputs.add(o.name);
          }
          if (!OUTPUT_KINDS.has(o.kind)) {
            issues.push({ target: `${oat}.kind`, reason: `kind 只能是 file|check|value，实际为 ${JSON.stringify(o.kind)}` });
          }
          if (o.path !== undefined && typeof o.path !== "string") {
            issues.push({ target: `${oat}.path`, reason: "path 必须是字符串" });
          }
        });
      }
    }
  });

  // 依赖必须指向存在的任务 id
  graph.tasks.forEach((t, i) => {
    for (const [j, d] of (t.deps ?? []).entries()) {
      if (typeof d === "string" && !ids.has(d)) {
        issues.push({ target: `tasks[${i}].deps[${j}]`, reason: `依赖的任务 "${d}" 不存在` });
      }
    }
  });

  // 无环校验（Kahn）：有环 = 环上任务互相等待，就绪集恒空
  const cycle = findCycle(graph.tasks);
  if (cycle.length > 0) {
    issues.push({ target: "tasks", reason: `依赖存在环，涉及任务：${cycle.join(" → ")}` });
  }

  return issues;
}

/** @returns 若校验失败抛 GraphValidationError，否则返回 undefined */
export function assertValidGraph(graph) {
  const issues = validateGraph(graph);
  if (issues.length > 0) throw new GraphValidationError(issues);
}

/** Kahn 拓扑：返回环上剩余的任务 id（空数组 = 无环） */
function findCycle(tasks) {
  const indeg = new Map();
  const edges = new Map();
  for (const t of tasks) {
    if (typeof t?.id !== "string" || !t.id) continue;
    indeg.set(t.id, 0);
    if (!edges.has(t.id)) edges.set(t.id, []);
  }
  for (const t of tasks) {
    if (typeof t?.id !== "string" || !t.id || !Array.isArray(t.deps)) continue;
    for (const d of t.deps) {
      if (!indeg.has(d)) continue; // 悬空依赖另行报错
      indeg.set(t.id, indeg.get(t.id) + 1);
      edges.get(d).push(t.id);
    }
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const done = new Set();
  while (queue.length) {
    const id = queue.shift();
    done.add(id);
    for (const next of edges.get(id)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  return [...indeg.keys()].filter((id) => !done.has(id));
}
