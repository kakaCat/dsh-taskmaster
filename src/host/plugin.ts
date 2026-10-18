// 宿主插件装配：cordis 插件入口。
// 职责：boot 引擎 → 心跳定时器驱动 reconcileAll → 订阅会话/子会话事件（活性计数）
// → 注册 tm_* 工具。
// 纪律：enabled=false 时零定时器零订阅，但工具读写照常（boot 仍返回 store/binder/gate 等核心模块）。

import { join } from "node:path";
import { homedir } from "node:os";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { boot } from "../engine/boot.ts";
import { TaskmasterTools } from "../tools/tools.ts";
import { makeChannels, textBlocks } from "./channels.ts";
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

// defineTool 直接静态依赖（@deepseek-ai/dsh-tools 已是真依赖）：
// 参数规范化与 output 契约校验由它保证——之前动态 import + 兜底的写法让真宿主的校验失效过。

export async function apply(ctx, config: any = {}) {
  const dataRoot = resolveDataRoot(config.dataRoot);

  // 活性计数器（探活信号）：subagent 生命周期 + 会话事件（长任务的真实活动信号）
  const activityCounters = new Map();
  const bumpActivity = (sessionId: string) => {
    if (!sessionId) return;
    activityCounters.set(sessionId, (activityCounters.get(sessionId) ?? 0) + 1);
  };

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
  // 注意：makeChannels 内部惰性解析服务——此刻 subagents 可能尚未 active，不能快照
  Object.assign(channels, makeChannels(ctx, (gid) => ownerAgentFor(gid, engine)));

  const adapters = makeAdapters({ get: ctx.get?.bind(ctx) }, activityCounters);
  // 主动探活（S2 #16）：经宿主 sendMessage 向驻留子会话投一条 ping（sender = 属主 agent）。
  // 真契约：content 必须是 ContentBlock[]，第四参 options 必须带 signal。
  adapters.probe = async (sessionId: string) => {
    const binding = engine.binder.bySession(sessionId);
    const parent = binding ? ownerAgentFor(binding.graphId, engine) : null;
    const subagents = ctx.get?.("subagents");
    if (parent && subagents?.sendMessage) {
      await subagents.sendMessage(parent, sessionId, textBlocks("Taskmaster 探活：请回一条进展（任意内容即可）"), {
        signal: AbortSignal.timeout(15_000),
      });
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
        await subagents.sendMessage(parent, sessionId, textBlocks(message), { signal: AbortSignal.timeout(15_000) });
      } // 属主不在场则跳过——打回事件已留痕，属主回来在视图可见
    },
  });

  registerTools(ctx, () => engine);

  if (engine.disabled) {
    // 开关关闭：只注册工具（读写照常），零定时器零订阅
    return;
  }

  // 心跳：每拍全量对账（事件只是加速，心跳是兜底）。
  // - 防重入：上一拍未结束不叠加下一拍（长投递时 setInterval 会并发触发）；
  // - 锁心跳：每拍刷新 .engine.lock mtime（否则活进程的锁 30s 后会被误判猝死接管）；
  // - 可停/可启：tm_engine_stop/start 真正停/启定时器（IF-7 的「心跳停」）。
  let timer: NodeJS.Timeout | null = null;
  let beating = false;
  const beat = async () => {
    if (beating) return;
    beating = true;
    try {
      engine.lock?.heartbeat?.();
      await engine.reconciler.reconcileAll();
    } catch (e) {
      ctx.logger?.error?.("taskmaster beat failed", e);
    } finally {
      beating = false;
    }
  };
  const startBeat = () => {
    if (timer) return;
    void beat(); // 首拍立即对账，不等一个节拍
    timer = setInterval(() => void beat(), engine.config.beatMs);
  };
  const stopBeat = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  engine.heartbeat = { start: startBeat, stop: stopBeat, running: () => timer !== null };

  // 单写者锁随 fiber 生命周期释放（否则卸载后重启会撞 engine-lock-held）
  ctx.effect(() => () => engine.lock?.release?.(), "taskmaster/lock");

  // 心跳定时器：cordis effect 托管清理（fiber dispose 时自动 clear，不依赖 timer 服务）
  ctx.effect(() => {
    startBeat();
    return () => stopBeat();
  }, "taskmaster/heartbeat");

  // 事件订阅（真实载荷已核准：subagent/end = { runId, provider, id, local, stopReason, lastAssistantMessage? }，
  // **没有 structured**——结构化捕获在服务内部，不经事件）。
  // 因此：交卷证据只认执行者的 tm_node_update；subagent/end 只是「执行者结束」信号。
  const onEnd = (info) => {
    const sessionId = String(info?.id ?? "");
    if (!sessionId) return;
    bumpActivity(sessionId);
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
  ctx.on("subagent/start", (info) => bumpActivity(String(info?.id ?? "")));
  // 真实活动信号：执行者会话的任何已提交事件都算活性。
  // （只订阅 subagent/start|end 会把 >silentMs 的长任务误判 stalled：运行中既不 start 也不 end。）
  ctx.on("session/event", (session) => bumpActivity(String(session?.id ?? "")));
}

function registerTools(ctx, engineOf) {
  const tm = () => new TaskmasterTools(engineOf());
  // 真实 defineTool 要求每个工具声明 output { schema, render }（dsh-tools 契约）；
  // 引擎返回结构统一为 { ok, ... }，用宽松 object schema + JSON 渲染。
  const OUTPUT = {
    schema: { type: "object", additionalProperties: true },
    render: (_args: any, value: any) => [{ type: "text", text: JSON.stringify(value) }],
  };
  const reg = (def) => ctx.tools.register(defineTool({ output: OUTPUT, ...def }));

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
      evidence: { type: "object", additionalProperties: true, description: "{ 判据序号: 证据 }" },
      blocked: { type: "boolean" },
      reason: { type: "string" },
    },
    async execute(args) {
      return tm().nodeUpdate(args);
    },
  });

  reg({
    name: "tm_status",
    description: "Taskmaster 量化视图（图/任务/在途/等待关系/引擎态，全部从图投影）",
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
    description: "引擎级恢复（运行态）：心跳重启、降级标记清除，在途由下一拍探活接管",
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
