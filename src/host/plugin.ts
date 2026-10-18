// 宿主插件装配：cordis 插件入口。
// 职责：boot 引擎 → 心跳定时器驱动 reconcileAll → 订阅 subagent 生命周期事件
// （收卷/活性计数）→ 注册 tm_* 六个工具。
// 纪律：enabled=false 时零定时器零订阅（读写照常由 tools 直通模块）。

import { join } from "node:path";
import { homedir } from "node:os";
import z from "@deepseek-ai/schemastery";
import { boot } from "../engine/boot.ts";
import { TaskmasterTools } from "../tools/tools.ts";
import { makeChannels } from "./channels.ts";
import { makeAdapters } from "./adapters.ts";
import { EventLog } from "../persister/event-log.ts";

export const name = "taskmaster";
export const inject = ["tools"];

// 宿主 Config（cordis 用 schemastery schema；缺省 dataRoot = <cwd>/.dsh/taskmaster）
export const Config = z.object({
  dataRoot: z.string(),
});

/** 数据根：与 dsh-window 同惯例——$DSH_HOME/storages/<plugin>（缺省 ~/.dsh）。 */
function resolveDataRoot(configured?: string): string {
  if (configured) return configured;
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, "storages", "dsh-taskmaster");
}

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

export async function apply(ctx, config: any = {}) {
  const dataRoot = resolveDataRoot(config.dataRoot);
  const defineTool = await resolveDefineTool(config);

  // 活性计数器（探活信号：subagent 生命周期事件驱动）
  const activityCounters = new Map();

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
  const channels: Record<string, any> = {};
  Object.assign(channels, makeChannels(ctx, (gid) => ownerAgentFor(gid, engine)));

  const adapters = makeAdapters({ get: ctx.get?.bind(ctx) }, activityCounters);
  // 主动探活（S2 #16）：经宿主 sendMessage 向驻留子会话投一条 ping（sender = 属主 agent）；
  // 子会话回消息会 bump activityCounters，下一拍 sweep 自然看到"活过来"。
  adapters.probe = async (sessionId: string) => {
    const binding = engine.binder.bySession(sessionId);
    const parent = binding ? ownerAgentFor(binding.graphId, engine) : null;
    const subagents = ctx.get?.("subagents");
    if (parent && subagents?.sendMessage) {
      await subagents.sendMessage(parent, sessionId, "Taskmaster 探活：请回一条进展（任意内容即可）");
    }
  };
  // fetchResult 保持 null：subagent/end 不带证据，停机期间完成的结果无法机械补验收——
  // Boot 第④步按 processAlive 走「活着重挂 / 死了标 stalled」，不猜证据。

  engine = await boot(dataRoot, {
    channels,
    adapters,
    cwd: process.cwd(),
    notifier: async (sessionId, message) => {
      // 打回通知：经 subagents.sendMessage 寻址驻留子会话（sender = 属主 agent）
      const binding = engine.binder.bySession(sessionId);
      const parent = binding ? ownerAgentFor(binding.graphId, engine) : null;
      const subagents = ctx.get?.("subagents");
      if (parent && subagents?.sendMessage) {
        await subagents.sendMessage(parent, sessionId, message);
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
  // 单写者锁随 fiber 生命周期释放（否则卸载后重启会撞 engine-lock-held）
  ctx.effect(() => () => engine.lock?.release?.(), "taskmaster/lock");

  // 心跳定时器：cordis effect 托管清理（fiber dispose 时自动 clear，不依赖 timer 服务）
  ctx.effect(() => {
    const timer = setInterval(beat, engine.config.beatMs);
    return () => clearInterval(timer);
  }, "taskmaster/heartbeat");

  // 事件订阅（真实载荷已核准：subagent/end = { runId, provider, id, local, stopReason, lastAssistantMessage? }，
  // **没有 structured**——结构化捕获在服务内部，不经事件）。
  // 因此：交卷证据只认执行者的 tm_node_update；subagent/end 只是「执行者结束」信号。
  const onEnd = (info) => {
    const sessionId = String(info.id ?? "");
    if (!sessionId) return;
    activityCounters.set(sessionId, (activityCounters.get(sessionId) ?? 0) + 1);
    const binding = engine.binder.bySession(sessionId);
    if (!binding) return; // 不是我们的执行者
    // 结束 ≠ 交卷：只留痕，不伪造证据。未交卷的 ended 由下一拍对账按异常路径上报（只报不修）。
    EventLog.open(join(dataRoot, "events", `${binding.graphId}.events.ndjson`)).append("executor-ended", {
      taskId: binding.taskId,
      runId: binding.runId,
      stopReason: info.stopReason,
    });
  };
  ctx.on("subagent/end", onEnd);
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
    name: "tm_engine_stop",
    description: "引擎级停止（运行态）：心跳停/零派发零探活；在途不杀、台账保留；重启或 tm_engine_start 恢复",
    parameters: {},
    async execute() {
      return tm().engineCtl({ action: "stop" });
    },
  });

  reg({
    name: "tm_engine_start",
    description: "引擎级恢复（运行态）：下一拍对账接管在途（等效 Boot ④ 重挂）",
    parameters: {},
    async execute() {
      return tm().engineCtl({ action: "start" });
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
