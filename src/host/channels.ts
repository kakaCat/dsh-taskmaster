// 宿主通道适配器（IF-8 的真接法；调研 E-7/E-8/E-9）。
// 约束（调研 F-8）：startActivation 要求 exact live parent agent——
// 属主窗口（meta.ownerSessionId）不在场时抛错，降级链自动落到 fork 档；全挂 = 纯对话流。
//
// 两个真宿主契约（2026-10-19 联调踩坑）：
//   ① **服务必须惰性取**：插件 apply 时 subagents 可能尚未 active（cordis 服务按 inject 依赖
//      渐进就绪）。装配期快照 ctx.get("subagents") 会得到 undefined，导致三档全部 unavailable。
//      这里每个通道在**调用时**再解析服务。
//   ② 请求形状按 dsh-subagent 源码：
//      - provider 必须是已注册名（base 组合只有 "spawn" / "fork"，没有 "default"）；
//      - startActivation 必须带 signal（宿主 resolveDirectory 无条件 signal.throwIfAborted()）；
//      - request.prompt 是 ContentBlock[]（不是字符串），否则会被按字符展开；
//      - sendMessage(sender, targetId, content: ContentBlock[], { signal }) 两个参数都不能省。

/** 任务包 → 执行者 prompt（视野最小化文本形态） */
export function renderPackage(pkg) {
  const lines = [
    `【Taskmaster 任务包】图 ${pkg.graphId}@v${pkg.graphVersion} ｜ 任务 ${pkg.taskId} ｜ 世代 ${pkg.runId}`,
    "",
    "## 任务陈述",
    pkg.statement,
    "",
    "## 验收判据（交卷逐条带证据）",
    ...pkg.checks.map((c, i) => `${i}. ${typeof c === "string" ? c : c.text}`),
  ];
  if (pkg.deps.length > 0) {
    lines.push("", "## 前置产出（只给路径+摘要）");
    for (const d of pkg.deps) {
      lines.push(`- ${d.taskId}: ${d.artifact ? `${d.artifact.path} —— ${d.artifact.summary}` : "（无留痕）"}`);
    }
  }
  if (pkg.writeScopes.length > 0) {
    lines.push("", "## 写域约束（只允许写这些路径）", ...pkg.writeScopes.map((s) => `- ${s}`));
  }
  if (pkg.roundBudget) lines.push("", `## 回合预算：${pkg.roundBudget}`);
  lines.push(
    "",
    "## 交卷方式",
    `完成后调用 tm_node_update({ graphId: "${pkg.graphId}", taskId: "${pkg.taskId}", runId: "${pkg.runId}", evidence: { <判据序号>: "<证据>" } })`,
    `被挡住时调用 tm_node_update({ ..., runId: "${pkg.runId}", blocked: true, reason: "<原因>" })`,
  );
  return lines.join("\n");
}

/** 文本 → 宿主 ContentBlock[] */
export function textBlocks(text: string) {
  return [{ type: "text", text }];
}

/**
 * 装配通道降级链（惰性解析宿主服务）。
 * @param ctx 宿主插件上下文
 * @param ownerAgentFor (graphId) → live agent | null（属主窗口的存活 agent）
 */
export function makeChannels(ctx, ownerAgentFor) {
  const channels: Record<string, any> = {};
  const liveSubagents = () => ctx.get?.("subagents");
  const signal = () => AbortSignal.timeout(60_000);

  const viaSubagents = (provider: string) => async (pkg: any) => {
    const subagents = liveSubagents();
    if (!subagents?.startActivation) throw new Error(`unavailable: subagents service（provider=${provider}）`);
    const parent = ownerAgentFor(pkg.graphId);
    if (!parent) throw new Error("no live owner agent（live parent 约束：属主窗口不在场）");
    const r = await subagents.startActivation({
      provider,
      // label 是 descriptor 的事实字段：宿主 snapshotSubagentDescriptor **无条件**写入
      // `label: spec.label`，省略会让 descriptor 出现 undefined 字段 → 非 lossless JSON，
      // 宿主直接抛 "subagent descriptor is not losslessly JSON-serializable"。
      label: `Taskmaster ${pkg.graphId}/${pkg.taskId}`,
      request: { parent, prompt: textBlocks(renderPackage(pkg)), maxDepth: 1 },
      signal: signal(),
      delivery: "parent",
    });
    const sessionId = r?.childId ?? r?.id;
    if (!sessionId) throw new Error(`subagents.startActivation（provider=${provider}）未返回子会话 id`);
    // 激活句柄的 result Promise 我们不消费（交卷证据只认 tm_node_update）：
    // 挂 noop catch 防止其 reject 时宿主进程吃 unhandledRejection。
    // dispose() 刻意不调——continuable 子会话要继续执行任务，句柄随宿主托管回收。
    void Promise.resolve(r?.result).catch(() => {});
    return { sessionId: String(sessionId) };
  };

  // 两档：本地 continuable 子会话（spawn）→ fork 兜底。
  // （曾有 branch 档走 window.openBranch，但宿主服务目录不存在 window 服务——死通道，已移除。）
  channels.startActivation = viaSubagents("spawn");
  channels.spawn = viaSubagents("fork");

  // 执行面就绪探测（启动期竞态用）：区分「暂时没 active」与「宿主根本没有执行面」。
  // ctx.get 的 strict 语义：provider fiber 不是 active 时返回 undefined——重启后首拍可能撞上。
  const subagentsImpl = () => {
    try {
      const store = (ctx as any).reflect?.store ?? {};
      for (const key of Object.getOwnPropertySymbols(store)) {
        const impl = (store as any)[key];
        if (impl?.name === "subagents") return impl;
      }
    } catch {
      /* 内部结构不可读 → 当作探测不到 */
    }
    return null;
  };
  const hasProvider = (s: any) => {
    if (typeof s?.getProvider !== "function") return true; // 无法探测 → 不阻塞
    return !!(s.getProvider("spawn") || s.getProvider("fork"));
  };
  const subagentsReady = () => {
    const s = liveSubagents();
    return !!(s?.startActivation && hasProvider(s));
  };
  const createdAt = Date.now();
  /** 启动宽限：服务还没被任何插件 provide 出来时，先按「暂未就绪」处理，不急着降级 */
  const STARTUP_GRACE_MS = 20_000;
  /** 现在就能投递至少一档？ */
  channels.available = () => subagentsReady();
  /** 未就绪是「暂时」还是「根本没有」？仅暂时返回 true（可延迟，不降级）。 */
  channels.pending = () => {
    if (subagentsReady()) return false;
    const impl = subagentsImpl();
    if (impl && impl.fiber?.state !== 2) return true; // 服务已注册、fiber 还没 active
    const s = liveSubagents();
    if (s?.startActivation && !hasProvider(s)) return true; // 服务在、provider 还没注册
    if (!impl && Date.now() - createdAt < STARTUP_GRACE_MS) return true; // 启动期：provider 插件还没加载
    return false; // 宽限已过仍不存在 → 交给 DeliveryFailed 降级
  };
  return channels;
}
