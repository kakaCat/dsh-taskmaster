// 宿主信号适配器（FR-7 探活 + FR-15 重挂的真接法）。
// 纪律：拿不到的信号就诚实返回 null/false 语义——monitor 对 null 不当作增长。

export interface HostAdapters {
  activityOf(sessionId: string): number | null;
  processAlive(sessionId: string): boolean;
  fetchResult: ((binding: any) => any) | null;
  probe?: (sessionId: string) => Promise<void>;
}

/**
 * @param ctx 宿主插件上下文
 * @param activityCounters Map<sessionId, number>（插件里由事件订阅维护的活性计数器）
 */
export function makeAdapters(ctx: any, activityCounters: Map<string, number>): HostAdapters {
  const agents = () => ctx.get?.("agents");
  return {
    // 留痕心跳：订阅侧计数（subagent 生命周期 + 子会话消息事件都会 bump）
    activityOf(sessionId) {
      return activityCounters.get(sessionId) ?? null;
    },
    // 进程存活：agents 注册表里有活会话即活（宿主语义：注册表只放 live agent）
    processAlive(sessionId) {
      const a = agents();
      if (!a?.get) return true; // 无注册表可查 → 不当作死（保守）
      return a.get(sessionId) != null;
    },
    // Boot 补验收的输入：停机期间完成的结果由 subagent/end 订阅缓存（插件侧 fetchEndResults）
    fetchResult: null, // 由插件装配时替换（需要访问 end 结果缓存）
  };
}
