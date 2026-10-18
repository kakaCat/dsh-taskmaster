---
title: Taskmaster 常驻引擎形态可行性 调研报告
status: draft
owner: 待定
reviewers: 待定
decision: D-1：S1 是否按「常驻宿主引擎」形态开工（服务 docs/projects/PRJ-0002/design/taskmaster-design.md 四风险表「可行性」行）
created: 2026-10-18
updated: 2026-10-18
---

# Taskmaster 常驻引擎形态可行性 调研报告

## 摘要  serves: 全文

- **调研问题**：Taskmaster 设计的「宿主插件级常驻引擎 + 心跳对账 + 持久化纪律 + 执行面投递」四个形态前提，在 DSH 现行架构（0.2.1-rc.2）下有没有生产级先例支撑？
- **办法**：源码与官方 README 研读，覆盖宿主运行时全部 307 个 @deepseek-ai 包，重点解剖先例包 dsh-schedule 全文（dsh-goal-round-driver 作为反面对照）+ 4 个底座包；时间窗 2026-10-18 单日。
- **结论**：D-1 **采纳**（v0.5 修正：`subagent/end` 源码级核准——事件载荷为 `{ runId, provider, id, local, stopReason, lastAssistantMessage? }`，**不含结构化结果**；结构化捕获是服务内部行为。引擎订阅事件可得「执行者结束」信号，但交卷证据只认执行者的 `tm_node_update`。spawn 需 exact live parent agent 的约束见 F-8）。
- **证据强度**：A 级 8 条、B 级 2 条；信息缺口全部闭合：性能量级已由 spike 实测（E-10：5000 任务单拍 P95 ≈ 23ms，节拍假设成立）。
- **这份调研不能用来决定什么**：不覆盖性能量级（节拍耗时、事件流体积）与多写者协同——前者留给 M1 基准，后者已显式排除在二期。

## 背景与调研问题  serves: 全文

### 要不要查：决策背景

设计文档四风险表把「常驻引擎形态可行性」标为「部分（语义层面已验证）」，依据只是"goal-round-driver 先例"一句话；交付计划把"宿主插件常驻形态未验证"列为 S1 #9 开工前的阻塞风险。S1 动工（2026-11-08 目标）前必须把这行从"部分"变成有出处的结论，否则 M1 可能在错误形态上开工。

### 调研问题清单

| 编号 | 调研问题 | 决策影响 | 影响程度 |
|---|---|---|---|
| Q-1 | 宿主级常驻服务（跨会话、重启存活、自管持久化域）在现行 DSH 下可行吗 | D-1：答否则退回纯工具形态 | 高 |
| Q-2 | 无人触发的自主续跑（事件驱动 + 回合推进）可行吗 | D-1：决定心跳循环的实现参照 | 中 |
| Q-3 | 持久化纪律（版本化存储域、CAS、原子写、损坏策略）有现成机制吗 | D-1：决定 persister 模块自建还是复用 | 高 |
| Q-4 | 执行面投递三通道（startActivation / window branch / spawnTeammate）宿主都提供吗 | D-1：决定 IF-8 降级链是否成立 | 高 |

### 调研问题明细

#### Q-1 宿主级常驻服务可行性

**调研问题**

在 DSH 0.2.1-rc.2 桌面宿主中，一个插件能否以宿主级（非会话级）服务常驻、持有自己的持久化存储域、并在应用重启后无需人工介入恢复运行？

**决策影响**

D-1。答「是」：S1 按设计文档架构开工；答「否」：退回备选方案 B（纯工具形态），需求 R-7/R-9/R-10 全部降级重议。

**调研与证据**

E-2（dsh-schedule 是宿主级常驻服务的完整先例：ScheduleService 持有一个 version-1 `schedule` 存储域，任务跨 Host 重启存活，重启后按需恢复冷会话投递）、E-3（cordis 插件框架与 timer 插件是宿主插件体系的底座，dsh-schedule 与全部宿主服务都挂载其上）。两条合起来：常驻（插件 service）+ 存活（durable domain）+ 恢复（重启重载域）三段都有同一先例走完。

**反证与限定条件**

- dsh-schedule 的投递是会话消息，Taskmaster 的派发是 spawn 执行者——常驻形态本身有先例，"常驻服务驱动执行面"的组合没有先例，该组合风险计入 Q-4 而非本问题。

#### Q-2 定时自触发可行性

**调研问题**

在现行 DSH 下，宿主级服务能否在无人输入时按自己的定时器自主触发工作（定时派发/投递），且不依赖任何会话回合？

**决策影响**

D-1。决定心跳对账循环的实现参照：若宿主级定时自触发有先例，则心跳循环按 schedule 的单 Host timer 模式实现。

**调研与证据**

E-2（dsh-schedule 实现节：一个 Host timer 驱动全部到期任务——到点自查、批量派发投递、会话冷恢复，全程无人参与；重启后重排 timer）、E-1（反面对照：dsh-goal-round-driver 是**会话内续跑**驱动——推进的是同一个 agent 的下一回合，与 Taskmaster 的"向 N 个执行者派发任务包"语义完全不同，**不能作为本问题的先例**，仅其授权纪律可参考）。合起来：定时自触发 + 无人投递的先例由 schedule 独立扛住；driver 不参与论证。

**反证与限定条件**

- schedule 的投递目标是会话消息，Taskmaster 是 spawn 执行者——timer 自触发有先例，"timer 驱动 spawn"的组合风险计入 Q-4。

#### Q-3 持久化纪律现成机制

**调研问题**

版本化持久化域、全量记录 CAS、单写者串行写、原子落盘、损坏启动策略，这五项在现行宿主里各有现成机制或先例吗？

**决策影响**

D-1。五项都有 → persister 是"按先例组装"；缺多项 → persister 成为 M1 最大工作量项，排期重估。

**调研与证据**

E-2（dsh-schedule 实现节：版本化存储域（version-1 schema，损坏/非法记录拒绝启动而不是带病开）；管理与派发写共享一条 FIFO；更新是整条记录 compare-and-set，冲突返回 schedule_conflict 不覆盖）、E-4（dsh-atomic-write 包存在于宿主依赖——原子写底座）。合起来：版本域、FIFO、CAS、原子写四项有直接先例或现成包；"损坏策略"我们刻意与 schedule 不同（它 fail-fast 拒启动，我们的投影可重建），差异已在设计文档数据模型节写明。

#### Q-4 执行面投递通道

**调研问题**

IF-8 降级链的三档通道——startActivation / window branch / spawnTeammate——在现行宿主里各自存在且可被插件 service 调用吗？

**决策影响**

D-1。三档都在 → 降级链成立；缺档 → 修 IF-8（删档或换档），不影响形态结论本身。

**调研与证据**

E-5（dsh-subagent-spawn-in-process 与 dsh-subagent-fork-in-process 包存在——spawnTeammate 通道的底座）、E-7（dsh-tool-subagent README：委派工具就是调 `ctx.subagents.startActivation()`——**startActivation 存在，且是 subagent service 的 service 级方法**，非工具私有；runtime 托管启动取消/执行/结果上报/清理）、E-8（dsh-subagent README：本包是"每次委派共享的契约"service，明文写 "Direct service callers continue to supply their own optional request depth"——**service 级调用面官方确认**；另发现宿主自带并发预算 `maxActiveSubagents` 默认 8，驻留子会话可再收发消息且不重复占槽——探活/打回寻址的宿主支持）、E-6（本运行时工具面实测可见 window_open / window_dispatch / window_send / spawn_teammate——branch 与 spawn 两档在工具层可用）。四条合起来：三档通道全部闭合——startActivation 与 spawn 为 service 级可调，branch 有工具层实测。**v0.1 的缺口（startActivation 未找到）已闭合。**

**反证与限定条件**

- ~~残余细节：completion notice 如何到达非 agent 调用方~~（v0.3 已闭合，v0.5 修正范围，E-9）：`subagent/start`/`subagent/end` 生命周期事件经宿主事件总线发布，非 agent 可订阅。**但 v0.5 源码核准推翻了「事件携带结构化结果」的表述**：载荷只有 `{ runId, provider, id, local, stopReason, lastAssistantMessage? }`；`request.outputSchema` 的结构化捕获在服务内部完成，不经事件。推论（已落 IF-3/设计）：**交卷证据只认执行者的 tm_node_update**，事件只是「执行者结束」信号；Boot 补验收无机械证据可补，在途处置按 processAlive 走「重挂/标 stalled」。
- v0.3 新约束：`startActivation` 要求 **exact live parent agent**（否则 UNAUTHORIZED）——引擎 spawn 必须以一个存活 agent 为父。属主窗口关闭期间 spawn/activation 两档不可用，须降级 branch 档或排队等属主回来（补投纪律不变）。已转化为 IF-8 设计约束，不再是开放假设。

## 调研方法与范围界定  serves: 全文

| 方法 | 具体做法 | 样本与规模 | 时间窗 | 局限 |
|---|---|---|---|---|
| 文档与源码研读 | 通读 dsh-schedule 官方 README 全文（含实现细节折叠节）+ dsh-goal-round-driver 全文（作反面对照）；枚举宿主全部包名定位底座包；读 dsh-subagent lib/index.js 关键节 | n = 307 个 @deepseek-ai 包；1 个先例包 + 1 个对照包全文 + 1 个包源码 | 2026-10-18 | README 是发行文档，与 rc 版本源码可能有微差 |
| 原型实测 | 心跳单拍成本 spike：合成链式依赖图（100/500/1000/5000 任务），按设计目录布局实测「读图 YAML + 读投影 + 读台账 + 就绪计算 + 事件追加」整拍耗时，各 30 拍取 P50/P95 | 4 个规模 × 30 拍 | 2026-10-18 | 合成图偏规整；未含事件流全量重放（崩溃重建路径）；单机 SSD |
| 运行时观察 | 本会话工具清单实测（window_*/spawn_teammate 可见） | 1 个运行时实例 | 2026-10-18 | 工具可见 ≠ service 可调，语义待源码确认 |

**范围界定**

- **纳入**：常驻形态、自主续跑、持久化机制、投递通道存在性——四个形态前提；
- **排除**：性能量级（节拍耗时、千任务规模）——留给 M1 基准；多写者协同——已显式排除在二期；UI 形态——开放问题另有负责人；
- **不做的事**：不评价宿主包内部代码质量；不做选型对比（Taskmaster 不自研 vs 外购的问题已在 PRD 备选方案收口）。

## 决策与结论  serves: 全文

| 决策编号 | 要做的决定 | 决策人 | 截止 |
|---|---|---|---|
| D-1 | S1（2026-11-08 前）是否按常驻宿主引擎形态开工 | S0 评审会（2026-10-25） | 2026-10-25 |

**当前建议**

**采纳**：按常驻形态开工。依据 E-2/E-3/E-4/E-5/E-7/E-8/E-9——常驻、定时自触发、持久化纪律、投递三通道、结果回报事件链全部有生产先例或源码级确认，无需发明新宿主能力。v0.1 的两个保留条件（v0.2 闭合）与 completion notice 收取机制（v0.3 源码级闭合）全部清零。翻转条件：心跳实测超节拍预算 → 节拍/TTL 重议（形态不变）；宿主重构 subagent service API → IF-8 适配层跟随（形态不变）。

## 证据索引  serves: 全文

| 编号 | 证据 | 来源分级 | 获取方式与日期 |
|---|---|---|---|
| E-1 | dsh-goal-round-driver README：同会话自动续跑（idle+armed+余量三条件）；取消/暂停/卸载抑制续跑；resume/fork 后默认 disarmed 需人授权；回合上限耗尽记 blocker | A | `/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai/dsh-goal-round-driver/README.md`（2026-10-18） |
| E-2 | dsh-schedule README：宿主级 ScheduleService；version-1 存储域损坏拒启动；管理/派发写共享 FIFO + 整条记录 CAS（schedule_conflict）；单 Host timer 至多一个挂起；session/flush 确认投递；重启恢复冷会话；archiveAdmission seam | A | 同路径 `dsh-schedule/README.md`（2026-10-18） |
| E-3 | cordis 插件框架 + cordis-plugin-timer 为宿主依赖底座，全部宿主服务挂载其上 | A | `dsh/package.json` dependencies 与 `node_modules/@deepseek-ai/cordis*`（2026-10-18） |
| E-4 | dsh-atomic-write 包存在于宿主依赖——原子写底座现成 | A | `node_modules/@deepseek-ai/dsh-atomic-write`（2026-10-18） |
| E-5 | dsh-subagent-spawn-in-process / dsh-subagent-fork-in-process 包存在——spawn 通道底座现成 | A | `node_modules/@deepseek-ai/dsh-subagent-*`（2026-10-18） |
| E-6 | 本运行时工具面实测含 window_open/window_dispatch/window_send/spawn_teammate——branch 与 spawn 两档通道在工具层可用 | B | 本会话工具清单（2026-10-18）；复现：任意会话查看自身工具列表 |
| E-7 | dsh-tool-subagent README：委派工具调用 `ctx.subagents.startActivation()`；runtime 托管启动取消/执行/结果上报/清理；启动失败为工具错误结果，发布后失败经 completion notice 到达 | A | `node_modules/@deepseek-ai/dsh-tool-subagent/README.md` L96（2026-10-18） |
| E-8 | dsh-subagent README：本包是委派共享契约 service；"Direct service callers continue to supply their own optional request depth"（service 级调用面官方确认）；`maxActiveSubagents` 默认 8（宿主并发预算）；驻留子会话再收发消息不重复占槽 | A | `node_modules/@deepseek-ai/dsh-subagent/README.md` L12/L49/L53（2026-10-18） |
| E-9 | dsh-subagent lib 源码（v0.5 修正）：`subagent/end` 载荷 = `{ runId, provider, id, local, stopReason, lastAssistantMessage? }`——**无 structured 字段**（结构化捕获在服务内部，`captureLocalResult` 不发布事件）；`startActivation` 要求 exact live parent agent（否则 UNAUTHORIZED）；`sendMessage(sender, targetId, content)` 签名确认 | A | `node_modules/@deepseek-ai/dsh-subagent/lib/index.js` L3036；`lib/types/lifecycle.js` L55-60；`lib/types/manager.js` L395（2026-10-19 复核） |
| E-10 | 心跳单拍 spike 实测：100/500/1000/5000 任务图的单拍 P95 分别 ≈1.2/2.4/4.7/23.4ms（含 YAML 读图 + 就绪计算 + 事件追加）；一期规模（数百任务）单拍成本比任何合理节拍间隔（秒级）低约 3 个数量级 | B | 可复现：`node scripts/bench-heartbeat.mjs`（本仓库，2026-10-18，Apple  Silicon 本地 SSD） |

## 关键发现  serves: Q-1、Q-2、Q-3、Q-4

| 编号 | 发现 | 支撑证据 | 事实或推断 | 可信度 |
|---|---|---|---|---|
| F-1 | 宿主级常驻 + 自管持久化域 + 重启恢复，有完整生产先例（schedule） | E-2 | 事实 | 高 |
| F-2 | 定时自触发 + 无人投递有生产先例（schedule 单 Host timer 到点自查、批量投递、冷会话恢复） | E-2 | 事实 | 高 |
| F-3 | 版本域/FIFO/CAS/原子写四项持久化机制全部有先例或现成包 | E-2、E-4 | 事实 | 高 |
| F-4 | 投递三通道全部闭合：startActivation 与 spawn 为 service 级 API（官方文档确认），branch 有工具层实测 | E-5、E-6、E-7、E-8 | 事实 | 高 |
| F-5 | schedule 坦承崩溃窗口可致重复投递——反过来证明我们 CAS 占位 + 世代凭据的必要性 | E-2 | 推断 | 中 |
| F-6 | goal-round-driver 与 Taskmaster 语义不同（会话内续跑 vs 跨执行者派发），不能作先例；仅其 armed/disarmed 授权纪律可参考 | E-1 | 事实 | 高 |
| F-7 | 宿主自带并发预算（maxActiveSubagents 默认 8）与驻留子会话消息机制——引擎并发上限是与宿主预算叠加而非替代；探活/打回有宿主消息通道支撑 | E-8 | 事实 | 高 |
| F-8 | 生命周期事件对非 agent 可达，但**只含结束信号**（stopReason/lastAssistantMessage），不含交卷证据；证据渠道唯一 = 执行者的 tm_node_update；spawn 需 exact live parent agent，属主不在场时降级 branch/排队 | E-9 | 事实 | 高 |
| F-9 | 心跳单拍成本在一期规模（数百任务）下为个位数毫秒，5000 任务也仅 ~21ms——「单拍 < 节拍间隔」假设成立，且有约 3 个数量级余量 | E-10 | 事实（合成图实测） | 中 |

### 与直觉相反的地方

最初的假设是"goal-round-driver 是 Taskmaster 的形态先例"——**本次调研推翻了它**：driver 推进的是同一个 agent 的下一回合（会话内续跑），Taskmaster 派发的是新执行者的新任务（跨执行者编排），两者只共享"插件能自动动作"这一最表层的机制。真正的同构先例是 dsh-schedule：宿主级常驻、自管持久化域、定时自触发、向会话投递带确认。教训入档：援引先例前先核对"驱动对象"是否同构。

## 方案对比矩阵  serves: Q-1

| 评估维度 | 权重 | 常驻宿主引擎（选用） | 纯工具形态 | 维持现状（人客串调度） | 标注 |
|---|---|---|---|---|---|
| 功能覆盖（监控/验收/续调闭环） | 40% | 5 / 5 | 1 / 5 | 0 / 5 | E-1、E-2 |
| 可行性（宿主先例支撑） | 30% | 4 / 5 | 5 / 5 | 5 / 5 | E-1~E-6 |
| 实现成本 | 20% | 2 / 5 | 5 / 5 | 5 / 5 | E-2（机制可复用，但引擎逻辑自建） |
| 失控风险 | 10% | 3 / 5（确认闸+开关兜底） | 4 / 5 | 1 / 5（全靠人） | E-1 |

## 结论与建议  serves: 全文

| 决策编号 | 结论 | 立场 | 成立条件 | 翻转条件 |
|---|---|---|---|---|
| D-1 | S1 按常驻宿主引擎形态开工；persister 按 schedule 先例组装（版本域+FIFO+CAS+原子写）；投递降级链三档保留（startActivation → branch → spawn → 纯对话流）；结果回报经 subagent 生命周期事件订阅 | 采纳 | 三通道 service 级可调 + 结果事件链均已源码级确认（E-7/E-8/E-9）；spawn 需 live parent agent 作为设计约束落入 IF-8 | 心跳实测超节拍预算 → 节拍/TTL 重议（形态不变）；宿主重构 subagent service API → IF-8 适配层跟随（形态不变） |

**不采纳的方案与理由**

- 纯工具形态：监控/续调退化为人记得调（E-1 反面对照），需求 R-7/R-9/R-10 直接落空；
- 复用 dsh-schedule 当引擎：它是按时间调度且投递语义是会话消息（E-2），与按依赖调度 + spawn 执行者语义错位（排重结论不变）。

## 风险与不确定性  serves: 全文

**最危险假设**（如果它错了，上面哪条结论直接作废）

- ~~「spawn 包暴露 service 级调用面」~~（v0.2 闭合：E-8）。~~「completion notice 能到达非 agent 调用方」~~（v0.3 闭合：E-9 源码确认生命周期事件订阅）。~~「心跳单拍 < 节拍间隔」~~（v0.4 闭合：E-10 实测 5000 任务单拍 P95 ≈ 23ms，余量约 3 个数量级）。**形态域假设全部闭合。** 项目级最危险假设是「人愿意过确认闸」——属 PRD 价值风险，不在本调研范围，由 M1 走查（驳回率 < 30%）证伪。

| 信息缺口 | 影响哪个结论 | 获取成本 | 处理方式 |
|---|---|---|---|
| ~~completion notice 的非 agent 调用方收取机制~~ | ~~IF-8 回报路径~~ | ~~0.5 人日~~ | 已决（v0.3，E-9：生命周期事件订阅，源码级） |
| spawn 请求参数面（回合预算/上下文注入细节） | FR-5 视野最小化实现细节 | 0.5~1 人日 | M1 #6 一并确认 |
| ~~心跳节拍在大图下的实测耗时~~ | ~~节拍/TTL 开放问题~~ | ~~M1 基准用例~~ | 已补（v0.4，E-10：5000 任务单拍 P95 ≈ 23ms，假设成立） |

## 开放问题  serves: 全文

| 问题 | 选项 | 负责人 | 截止 |
|---|---|---|---|
| startActivation 是否存在且可调 | 存在→保留首档 / 不存在→降级链从 window branch 起 | 已决：存在，为 `ctx.subagents.startActivation()` service 级方法（E-7，2026-10-18） | 已决 |
| spawn 是否暴露 service 级调用面 | 是→直连 / 否→IF-8 改工具间接路径 | 已决：是，dsh-subagent README 明文 direct service callers（E-8，2026-10-18） | 已决 |
| completion notice 的非 agent 调用方收取机制 | 事件回报→直连 / 仅会话内→IF-8 改轮询留痕 | 已决：事件回报直连，`subagent/end` 经事件总线订阅（E-9，2026-10-18） | 已决 |

## 附录  serves: 全文

- **实测脚本与原始数据**：E-6 复现方式见证据索引；包枚举命令 `ls node_modules/@deepseek-ai`（宿主 checkout，2026-10-18，307 个包）。
- **相关文档**：[设计文档](../projects/PRJ-0002/design/taskmaster-design.md)（四风险表「可行性」行由本报告回填）、[交付计划](../projects/PRJ-0002/plan/taskmaster-plan.md)（风险行同步）、[PRD](../projects/PRJ-0002/prd/taskmaster-prd.md)。
- **评审与复议记录**：随 S0 评审（2026-10-25）一并过。
- **变更历史**：v0.1（2026-10-18）首版（有条件采纳，两个保留条件）；v0.1 修正（同日）：goal-round-driver 降为反面对照，Q-2 重写由 E-2 独立支撑；v0.2（同日）：E-7/E-8 闭合两个保留条件，D-1 升级为采纳，新增 F-7（宿主并发预算与驻留子会话消息机制），最危险假设更替为 completion notice 收取机制；v0.3（同日）：E-9 源码级闭合 completion notice（生命周期事件订阅），发现 spawn 需 exact live parent agent 约束并转化为 IF-8 设计约束，最危险假设更替为大图节拍耗时，信息缺口清零；v0.4（同日）：E-10 心跳 spike 实测闭合性能假设（5000 任务单拍 P95 ≈ 23ms），形态域假设全部闭合，实测脚本入库 `scripts/bench-heartbeat.mjs`；v0.5（2026-10-19）：宿主联调前源码复核修正 E-9/F-8——`subagent/end` 不含结构化结果，交卷证据只认 tm_node_update；Boot 补验收机制按「无机械证据可补」处置。
