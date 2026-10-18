---
title: Taskmaster（dsh-taskmaster）交付计划
status: draft
owner: 待定
created: 2026-10-18
updated: 2026-10-18
---

# Taskmaster 交付计划

上游：[PRD v0.1](../prd/taskmaster-prd.md) ｜ [设计 v0.1](../design/taskmaster-design.md) ｜ [需求池 v2.0](../requirement/taskmaster-requirements.md)。
本文只回答"怎么分批做、每批的出口是什么、卡在哪等谁"。

## 总览

| 批次 | 内容 | 出口判据 | 目标日期 | 依赖 |
|---|---|---|---|---|
| S0 | 评审收敛：PRD/设计评审 + 4 条开放问题裁决 | 开放问题清零或各有负责人；文档转 approved | 2026-10-25 | 三件套评审 |
| S1 = M1 | 核心闭环（16 条 Must + 被动心跳 + 基础投影，并发固定 1） | 13 步走查全过（见下） | 2026-11-08 | ~~S0 通过~~ S0 豁免（见下） |
| S2 = M2 | 增强（并行裁决/主动探活/死锁巡检/引擎停止） | 卡死/死锁注入测试通过 | 2026-11-22 | M1 走查通过 |

> **S0 豁免留痕**：2026-10-18 需求方指令直接开工（"继续"），不等 2026-10-25 评审会。4 条开放问题按 [S0 评审议题](taskmaster-s0-review.md)的"倾向"作为**工作假设**（确认闸=投属主会话；checks 声明 verify 白名单制；节拍=全局默认+预留图级字段；执行者=每次 spawn），评审补确认时如有出入再修订。可行性已由[调研 v0.4](../../../research/taskmaster-resident-feasibility.md) 源码级+实测闭合（D-1 采纳，无保留条件）。

## S1 工作分解（按设计模块切，依赖序即施工序）

| # | 工作项 | 覆盖需求 | 依赖 | 出口判据 |
|---|---|---|---|---|
| 1 | persister：事件流 append / 原子写 / CAS / 单写者锁 | NFR-5 | 无 | 删 state.json 重建演练过 |
| 2 | graph-store：图 schema / 无环校验 / 版本只增不删 | FR-1 | #1 | AC-1.1/1.2/1.3 全过 |
| 3 | binder：绑定台账 + 世代凭据 | FR-14 | #1 | AC-14.1/14.2 过 |
| 4 | scheduler：就绪计算（串行，并发=1） | FR-2 | #2 | AC-2.1 拒绝日志可证伪 |
| 5 | gate：计划卡生成/幂等更新/confirm | FR-4 | #4 | AC-4.1 零 spawn |
| 6 | deliverer：通道降级 + 占位回滚 + 留痕 | FR-10 | #3 #5 | AC-10.1/10.2 过 |
| 7 | acceptor：交卷世代校验 + checks 核验 + 打回 | FR-5/FR-6 | #6 | AC-6.1 打回寻址过 |
| 8 | monitor：被动心跳（events seq）+ stalled 标记 | FR-7（被动部分） | #3 | 卡死一拍内标 stalled |
| 9 | reconciler：常驻心跳全量对账 | FR-8 | #4~#8 | AC-8.1/8.2 过 |
| 10 | graph lifecycle：暂停/恢复/停止/注销 | FR-11/12/13 | #9 | AC-11.1/12.1/13.1 过 |
| 11 | Boot 五步自举 + 在途重挂 | FR-15 / NFR-2 | #1 #3 #9 | kill 重启演练过 |
| 12 | statuser：tm_status 基础投影（含生命周期态） | FR-9 | #2 #10 | group_by=kind 与图一致 |
| 13 | 开关与降级：enabled + 纯对话流兜底 | NFR-3 | #6 | 关开关零 spawn |
| 14 | tm_* 工具面装配（IF-1~IF-6） | 全部 | #1~#13 | 走查脚本可执行 |

## S1 出口：M1 走查脚本（13 步）

注册 3 任务图（建表→接口→测试）→ 计划卡确认派建表 → 模拟卡死标 stalled 报人 → 人裁 resume → 交卷验收过 → 自动出下一批计划卡派接口 → 证据缺失拒收打回 → 补齐过 → 派测试 → 图完成 → 关开关零 spawn → 投递失败回滚留痕 → 暂停/停止/注销走查 → kill 应用重验续调（不重复、不跳步、在途重挂）。

## S2 工作分解

| # | 工作项 | 覆盖需求 | 依赖 | 出口判据 |
|---|---|---|---|---|
| 15 | 并行派发 + 写域裁决 + 并发上限可配 | FR-3 | M1 | AC-3.1 过 |
| 16 | 主动探活 + silent 分级 + TTL 调参 | FR-7（完整） | M1 | 卡死注入测试计时达标 |
| 17 | 死锁巡检与上报 | NFR-1 配套 | M1 | 死锁图上报且零动作 |
| 18 | tm_engine_stop（IF-7） | FR-16 | M1 | AC-16.1 过 |

## 风险与卡点

| 风险/卡点 | 等谁 | 预案 |
|---|---|---|
| 4 条开放问题未裁决 | S0 评审（2026-10-25） | 评审现场逐条过，当场定 |
| 宿主插件常驻形态 | 已有调研结论（[research](../../research/taskmaster-resident-feasibility.md)：D-1 采纳，通道三档 + 结果回报事件链源码级闭合） | 调研 v0.3 已读源码；S1 #6 剩参数面细节（回合预算/上下文注入），随实现确认 |
| 活性 TTL 误判 | S2 #16 | 三层信号互相印证，注 EntryPoint 入测试调参 |
| owner/reviewers 未定 | 需求方 | S0 前指定 |

## 变更历史

- v0.1（2026-10-18）首版：按 PRD 时间线展开 S0/S1/S2 三批，S1 拆 14 个工作项。
- v0.2（2026-10-19 凌晨）：S1 #1~#14 全部完成，M1 走查 13 步以端到端测试全绿（87/87，离线假通道/假适配器）。**距离真正 M1 出口还差**：宿主通道适配器（startActivation/branch/spawn 真接法）+ subagent 事件订阅接线 + 宿主插件装配（心跳定时器挂宿主生命周期）。这些是宿主集成工作，不改变已验证的引擎语义。
- v0.3（2026-10-19 凌晨二轮）：宿主集成落地（90/90）：cordis 插件装配 `src/host/plugin.js`（心跳定时器 + subagent 生命周期事件订阅 + 六个 tm_* 工具）、通道适配器（ctx.subagents.startActivation，live parent = 属主 agent 约束真实兑现）、信号适配器（活性计数/进程存活）、runId 世代先于投递签发（任务包携带凭据）。**Mock 宿主（cordis 形状）全链路测试通过**；剩余 = 真 cordis 宿主联调（Config schema/Service 生命周期/真实 startActivation 请求契约/subagent/end 消息形状），属联调验证不属编码。

- v0.4（2026-10-19）：工程化补齐——全量迁移 TypeScript（src 25 文件 / test 15 文件，Node 24 原生 type-stripping 直跑零构建）；新增 src/types.ts 领域类型；`tsc --noEmit` 零错误。**迁移期欠账**：`noImplicitAny` 暂关（动态 JSON/YAML 边界仍用 any），后续逐模块收紧；真宿主联调与 S2 不受影响。
- v0.5（2026-10-19）：S2 四个工作项落地（94/94 + tsc 0）：#15 写域裁决与并行批（`arbitrate` 先到先得 + 并发槽，config.concurrency 1~16）、#16 主动探活（silent 超 TTL 先探活一次，仍沉默下拍 stalled；probe 经宿主寻址）、#17 死锁巡检上报抽为可测方法（等待集哈希去重）、#18 引擎级停止/恢复（IF-7：tm_engine_stop/tm_engine_start，在途不杀、台账保留）。S2 出口：卡死/死锁注入测试与并行冲突计划卡均已覆盖（test/s2.test.ts、monitor.test.ts）。
- v0.6（2026-10-19）：真机联调完成——真实 cordis 框架装配冒烟通过（test/cordis-smoke.test.ts）：真实 Context + timer 插件 + `{name,inject,Config,apply}` 对象插件协议 + 工具经 cordis 服务注册 + `ctx.effect` 托管心跳定时器 + dispose 全量清理。修正：Config 改为 schemastery schema（cordis 要求）；心跳改 `ctx.effect`（不再依赖 timer 服务注入）。全量 95/95、tsc 0。剩余：DSH 桌面 composition 的插件清单登记（loader 侧配置），属发布环节。
- v0.7（2026-10-19）：发布形态就绪——bundle 打包（tsdown → dist/index.mjs，外部化宿主包）、`cordis.patch.yml` 装载层（insert: dsh-taskmaster）、package.json 增加 main/exports/files/dsh.bundle、数据根按惯例落 `$DSH_HOME/storages/dsh-taskmaster`；已在 `~/.dsh/profiles/desktop` 登记 link + bundles（备份 package.json），profile pnpm 解析通过。**激活需重启 DSH 桌面应用**（loader 在启动时组装 composition）；重启后新一轮会话应出现 tm_* 工具（默认 enabled=false，需在 dataRoot/config.yaml 打开）。
- v0.8（2026-10-19）：真机黑盒测试后的修复批次（111/111 + tsc 0）：
  - **输出契约**：`tm_*` 错误返回不再带 `issues: undefined`（真宿主 dsh-tools 判 non-lossless JSON，会把所有错误码替换成 `tool returned invalid output`）；`evidence-insufficient` 的 `missing` 一并透出。
  - **投递链**：通道改惰性解析宿主服务（apply 时 `subagents` 尚未 active 会导致三档全 unavailable）；`provider: default → spawn/fork`；`startActivation` 补 `signal`、`prompt` 改 `ContentBlock[]`；探活/打回 `sendMessage` 补 `ContentBlock[]` 与 `{ signal }`。
  - **单写者锁**：心跳每拍刷新 mtime；活进程的锁即使 mtime 过期也绝不接管（旧逻辑 30s 后把活锁当猝死锁抢走）；接管留痕 `reports/`。
  - **开关语义**：`enabled=false` 仍装配 store/binder/gate/ctl/acceptor，tm_* 读写可用（旧实现所有工具 internal 错）。
  - **可运维**：`tm_status` 暴露 engine 态（degraded/stopped/heartbeat）；`tm_engine_start` 清降级并重启心跳；`tm_engine_stop` 真停定时器；心跳防重入。
  - **权限/视图/校验**：非属主 confirm/graph_ctl/task_action/改图 → `authority-required`；`tm_status` 缺图回 notice；`ready` 不再混入 inFlight；未知键（图/任务/判据）注册即拒。
  - **活性**：新增 `session/event` 订阅——只订阅 subagent start/end 会把 >silentMs 的长任务误判 stalled。
  - **注意**：dist 已重建，但生效仍需重启桌面应用；当前进程内的 degraded 标记也随重启清零。
- v0.9（2026-10-19）：**启动期竞态根治**（118/118 + tsc 0）。v0.8 修完仍留一个真机才暴露的洞：心跳首拍可能早于 `subagents` 服务 active，投递失败即置 `degraded: true` 且**永不自愈**（后续派发全被 `engine.degraded` 拦下，只能人工 `tm_engine_start`）。根治分三层：
  - **可延迟错误**：新增 `DeliveryDeferredError`（`code: delivery-deferred`）——「执行面还没起来」与「执行面根本没有」是两回事，前者不该降级。
  - **就绪探测**（`src/host/channels.ts`）：`channels.available()` / `channels.pending()`。`pending` 只在真·暂时态返回 true：服务 impl 已注册但 `fiber.state !== 2`；或服务 active 但 provider（spawn/fork）尚未注册；或启动宽限 20s 内服务尚未出现。宽限过后仍无执行面 → `pending=false` → 照旧 `DeliveryFailed` 降级（**永久不存在仍要显式报警**，不静默）。
  - **投递器步骤 ⓪**：占位（`ready → dispatching`）**之前**先问 `available()`；未就绪且 `pending()` → 抛 `DeliveryDeferredError`，**零占位、零绑定、零失败留痕**，任务留 `ready`。reconciler 两处 catch 先认延迟（记 `delivery-deferred:<taskId>`）再认失败，故既不降级也不写 failed run，下一拍自然重试。
  - **真机验证**（重启窗口内冷启动竞态，见 [真机验证报告](taskmaster-live-verification.md)）：宿主重启后引擎 `17:42:06.260Z` 取锁并立即首拍，`dispatch@17:42:11.321Z` 恰为锁后 1 个 beat —— 首拍被延迟逻辑接管、下一拍补投递成功；无 `delivery-failed`、`degraded:false`；执行者交卷 `accept@17:43:41.669Z`，图转 `asleep`。
- v0.10（2026-10-19）：**task schema 扩展（向后兼容）**（123/123 + tsc 0，dist 已重建）。为 L2 展开补上承载字段：
  - **新字段**：`tasks[].expansion`（`atomic|expanded`，缺省语义 = atomic）、`tasks[].outputs`（`[{name, kind:file|check|value, path?}]`；name 在任务内唯一，边按 name 引用）。
  - **校验**：形状/枚举/未知键逐条报出（`tasks[i].expansion`、`tasks[i].outputs[j].*`）；旧图无新字段照常通过；未知键仍以 `invalid-graph` 拒绝，schema 只增不改。
  - **入口不变**：仍只经 `validateGraph` / `tm_upsert` 单一入口；新字段随版本快照落盘、可回读。
- v0.11（2026-10-19）：**无依赖任务没有真并行**（126/126 + tsc 0，dist 已重建）。用户观察：图里三个互相无依赖的任务只跑一个。真机日志坐实：`19:11:29.212Z ready:[pack-pm,pack-loader,tpl-format]`，同一毫秒 `plan-offered batch:["engine-schema"]`——批次恒为 1。两层根因都要修：
  - **并发缺省 = 1**（`config.concurrency`）：`arbitrate` 的槽位是 `concurrency - 在途数`，配置为 1 时每批永远只装 1 个。缺省改为 **8**（对齐宿主 `maxActiveSubagents` schema 缺省 8），钳制区间仍 1~16。
  - **写域判定把共享宽泛声明当互斥**（真正的元凶）：`overlaps()` 用字符串前缀相交，而实际图里几乎每个任务都声明 `test/**`，于是 `test/**` vs `test/**` 互判冲突 → 即使并发调到 8，批次仍是 1（实测 `concurrency=8 → batch:[tpl-format] conflicts:[expand-contract]`）。改为：**完全相同的宽泛声明（含通配或目录尾斜杠）= 共享域，不互斥**；同具体文件、目录包含关系（`src/api/` vs `src/api/user.ts`）仍然串行——真冲突不放松。
  - **配置热生效**：`concurrency` 原先在 boot 时一次性注入 reconciler，改 `config.yaml` 要重启才生效，与 `EngineGuard` 既有「配置每拍重读」语义不一致。改为每拍从 `guard.config` 读。
  - 回归测试：`test/s2.test.ts` 新增 3 条——多任务共享 `test/**` 必须同批、真冲突仍串行、改配置下一拍生效。
