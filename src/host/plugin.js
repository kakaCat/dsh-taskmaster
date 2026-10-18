// 宿主插件装配：cordis 插件入口。
// 职责：boot 引擎 → 心跳定时器驱动 reconcileAll → 订阅 subagent 生命周期事件
// （收卷/活性计数）→ 注册 tm_* 六个工具。
// 纪律：enabled=false 时零定时器零订阅（读写照常由 tools 直通模块）。

import { join } from "node:path";
import { boot } from "../engine/boot.js";
import { TaskmasterTools } from "../tools/tools.js";
import { makeChannels } from "./channels.js";
import { makeAdapters } from "./adapters.js";

export const name = "taskmaster";
export const inject = ["tools"];

// 宿主 Config 约定：{ dataRoot?: string }（缺省 <cwd>/.dsh/taskmaster）
export const Config = {
  type: "object",
  properties: { dataRoot: { type: "string" } },
};

/**
 * defineTool 解析：宿主挂着 @deepseek-ai/dsh-tools 就用真的（schema 校验/输出规范化），
 * 离线单测环境没有该包则退化为最小规范化——工具语义由 tmp 模块自身保证，不依赖宿主 schema。
 */
async function resolveDefineTool(config) {
  if (config.defineTool) return config.defineTool;
  try {
    const mod = await import("@deepseek-ai/dsh-tools");
    return mod.defineTool;
  } catch {
    return (def) => ({ ...def, parameters: def.parameters ?? {} });
  }
}

export async function apply(ctx, config = {}) {
  const dataRoot = config.dataRoot ?? join(process.cwd(), ".dsh", "taskmaster");
  const defineTool = await resolveDefineTool(config);

  // 活性计数器 + end 结果缓存（Boot 补验收与运行时收卷共用）
  const activityCounters = new Map();
  const endResults = new Map(); // sessionId → { structured, stopReason, at }

  const agents = () => ctx.get?.("agents");
  const ownerAgentFor = (graphId, engine) => {
    try {
      const owner = engine.store.meta(graphId).ownerSessionId;
      return owner ? (agents()?.get?.(owner) ?? null) : null;
    } catch {
      return null;
    }
  };

  let engine; // boot 后可用
  const channels = {};
  Object.assign(channels, makeChannels({ subagents: ctx.subagents, get: ctx.get?.bind(ctx) }, (gid) => ownerAgentFor(gid, engine)));

  const adapters = makeAdapters({ get: ctx.get?.bind(ctx) }, activityCounters);
  adapters.fetchResult = (binding) => endResults.get(binding.sessionId) ?? null;

  engine = await boot(dataRoot, {
    channels,
    adapters,
    cwd: process.cwd(),
    notifier: async (sessionId, message) => {
      // 打回通知：经 subagents.sendMessage 寻址驻留子会话（sender = 属主 agent）
      const binding = engine.binder.bySession(sessionId);
      const parent = binding ? ownerAgentFor(binding.graphId, engine) : null;
      if (parent && ctx.subagents?.sendMessage) {
        await ctx.subagents.sendMessage(parent, sessionId, message);
      } // 属主不在场则跳过——打回事件已留痕，属主回来在视图可见
    },
  });

  if (engine.disabled) {
    // 开关关闭：只注册工具（读写照常），零定时器零订阅
    registerTools(ctx, () => engine, defineTool);
    return;
  }

  // 心跳：每拍全量对账（事件只是加速，心跳是兜底）
  const beat = () => engine.reconciler.reconcileAll().catch((e) => {
    ctx.logger?.error?.("taskmaster beat failed", e);
  });
  if (ctx.setInterval) ctx.setInterval(beat, engine.config.beatMs);
  else {
    const timer = setInterval(beat, engine.config.beatMs);
    ctx.on("dispose", () => clearInterval(timer));
  }

  // 事件订阅：子会话结束 = 收卷时机；生命周期与消息事件 = 活性心跳
  const onEnd = async (info) => {
    const sessionId = String(info.id ?? info.childId ?? "");
    if (!sessionId) return;
    activityCounters.set(sessionId, (activityCounters.get(sessionId) ?? 0) + 1);
    endResults.set(sessionId, { structured: info.structured ?? null, stopReason: info.stopReason, at: new Date().toISOString() });
    const binding = engine.binder.bySession(sessionId);
    if (!binding) return; // 不是我们的执行者
    const evidence = info.structured?.evidence ?? {};
    // 交卷：世代与 checks 由 acceptor 裁决；补不上/被打回都留痕，下一拍对账兜底
    const graph = engine.store.get(binding.graphId, binding.graphVersion);
    await engine.acceptor
      .submit({ graphId: binding.graphId, graph, taskId: binding.taskId, runId: binding.runId, evidence })
      .catch(() => {}); // 拒收/打回走事件留痕，不在订阅里炸
  };
  ctx.on("subagent/end", (info) => void onEnd(info));
  ctx.on("subagent/start", (info) => {
    const sessionId = String(info.id ?? "");
    if (sessionId) activityCounters.set(sessionId, (activityCounters.get(sessionId) ?? 0) + 1);
  });

  registerTools(ctx, () => engine, defineTool);
}

function registerTools(ctx, engineOf, defineTool) {
  const tm = () => new TaskmasterTools(engineOf());
  const reg = (def) => ctx.tools.register(defineTool(def));

  reg({
    name: "tm_upsert",
    description: "注册或更新 Taskmaster 任务图（校验通过才落盘，版本只增不删）",
    parameters: {
      graphYaml: { type: "string", required: true, description: "图 YAML 全文" },
      graphId: { type: "string", description: "改图时给出；省略 = 新建" },
    },
    async execute(args, exec) {
      return tm().upsertGraph({ ...args, ownerSessionId: exec.agent?.session?.id ?? null });
    },
  });

  reg({
    name: "tm_confirm",
    description: "确认或驳回 Taskmaster 计划卡（不带确认永不派发）",
    parameters: {
      graphId: { type: "string", required: true },
      planId: { type: "string", required: true },
      reject: { type: "boolean", description: "true = 驳回" },
      reason: { type: "string", description: "驳回理由" },
    },
    async execute(args, exec) {
      return tm().confirmPlan({ ...args, actor: exec.agent?.session?.id ?? "unknown" });
    },
  });

  reg({
    name: "tm_node_update",
    description: "执行者交卷（带 checks 逐条证据）或报 blocked",
    parameters: {
      graphId: { type: "string", required: true },
      taskId: { type: "string", required: true },
      runId: { type: "string", required: true, description: "世代凭据（任务包里的 runId）" },
      evidence: { type: "object", description: "{ 判据序号: 证据 }" },
      blocked: { type: "boolean" },
      reason: { type: "string" },
    },
    async execute(args) {
      return tm().nodeUpdate(args);
    },
  });

  reg({
    name: "tm_status",
    description: "Taskmaster 量化视图（图/任务/在途/等待关系，全部从图投影）",
    parameters: {
      graphId: { type: "string" },
      groupBy: { type: "string", description: "kind | story | milestone" },
      taskId: { type: "string" },
    },
    async execute(args) {
      return tm().status(args);
    },
  });

  reg({
    name: "tm_graph_ctl",
    description: "图级人裁：pause/resume/stop/deregister（注销需 confirm=true，不可逆）",
    parameters: {
      graphId: { type: "string", required: true },
      action: { type: "string", required: true, description: "pause | resume | stop | deregister" },
      confirm: { type: "boolean", description: "deregister 必须显式 true" },
    },
    async execute(args, exec) {
      return tm().graphCtl({ ...args, actor: exec.agent?.session?.id ?? "unknown" });
    },
  });

  reg({
    name: "tm_task_action",
    description: "任务级人裁：resume/reassign/reopen（签发新世代，引擎自身调不到这里）",
    parameters: {
      graphId: { type: "string", required: true },
      taskId: { type: "string", required: true },
      action: { type: "string", required: true, description: "resume | reassign | reopen" },
      reason: { type: "string" },
    },
    async execute(args, exec) {
      return tm().taskAction({ ...args, actor: exec.agent?.session?.id ?? "unknown" });
    },
  });
}
