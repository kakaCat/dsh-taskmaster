// 宿主通道适配器（IF-8 的真接法；调研 E-7/E-8/E-9）。
// 约束（调研 F-8）：startActivation/spawn 档要求 exact live parent agent——
// 属主窗口（meta.ownerSessionId）不在场时这两档抛错，降级链自动落到 branch/纯对话流。
// 每档都是鸭子类型探测：宿主没挂对应 service 就视为 unavailable（不注册该档）。

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

/**
 * 装配通道降级链。
 * @param ctx 宿主插件上下文
 * @param ownerAgentFor (graphId) → live agent | null（属主窗口的存活 agent）
 */
export function makeChannels(ctx, ownerAgentFor) {
  const channels: Record<string, any> = {};

  // startActivation / spawn 两档都走 subagents service，provider 不同
  if (ctx.subagents?.startActivation) {
    const viaSubagents = (provider) => async (pkg) => {
      const parent = ownerAgentFor(pkg.graphId);
      if (!parent) throw new Error("no live owner agent（live parent 约束：属主窗口不在场）");
      const r = await ctx.subagents.startActivation({
        provider,
        request: { parent, prompt: renderPackage(pkg), maxDepth: 1 },
      });
      return { sessionId: String(r.childId ?? r.id) };
    };
    channels.startActivation = viaSubagents("default");
    channels.spawn = viaSubagents("spawn");
  }

  // branch 档：window service（鸭子类型；没有就不注册）
  const windowSvc: any = ctx.get?.("window");
  if (windowSvc?.openBranch) {
    channels.branch = async (pkg) => {
      const r = await windowSvc.openBranch({ prompt: renderPackage(pkg) });
      return { sessionId: String(r.sessionId ?? r.windowKey) };
    };
  }

  return channels;
}
