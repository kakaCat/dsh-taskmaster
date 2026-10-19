# dsh-taskmaster

宿主常驻的 agent 任务调度引擎（DSH Cordis Host 插件）：把一张任务图（DAG）注册进来，引擎按依赖关系逐批出**计划卡**，经人确认后派发给子会话执行者，执行者带证据交卷，引擎逐判据验收、级联解锁后续任务。全部状态可从事件流重建，崩溃/重启不丢账。

## 工具面（8 个 `tm_*`）

| 工具 | 用途 |
|---|---|
| `tm_upsert` | 注册/更新任务图（校验全过才落盘，版本只增不删） |
| `tm_confirm` | 确认/驳回计划卡（不确认永不派发；卡上就绪集哈希漂移 = plan-stale） |
| `tm_node_update` | 执行者交卷（逐判据带证据）或报 blocked |
| `tm_status` | 量化视图（计数/波次/等待关系/活性/引擎态） |
| `tm_graph_ctl` | 图级人裁：pause / resume / stop / deregister（注销需 confirm=true） |
| `tm_task_action` | 任务级人裁：resume / reassign / reopen（签发新世代） |
| `tm_engine_stop` / `tm_engine_start` | 运行态停/启引擎（心跳停、零派发零探活、台账保留） |

## 配置

两层配置，别混淆：

1. **Cordis 行配置**（`cordis.patch.yml` 的 `config`）：只有 `dataRoot`——数据根目录，缺省 `$DSH_HOME/storages/dsh-taskmaster`。
2. **引擎配置**（`<dataRoot>/config.yaml`，每拍重读、改完下一拍生效）：

```yaml
enabled: false      # 总开关：缺省关闭——不派发不探活，但 tm_* 读写照常
beatMs: 5000        # 心跳节拍（钳制 1s~5min）
silentMs: 90000     # 探活 TTL：沉默超此 → 主动探活一次 → 仍沉默 → stalled 报人
concurrency: 8      # 并行上限（钳制 1~16；写域冲突的任务自动串行）
autoFacets: []      # gate=auto 里程碑切面：整批都在这些里程碑内 → 免确认
```

## 关键设计纪律

- **不确认不派发**：派发只信 `tm_confirm` 返回的批次；计划卡透出本批的 mechanical 核验命令，人审不盲签。
- **世代凭据**：每次派发签发新 runId，旧世代交卷/回报一律 stale-run 拒收。
- **只报不修**：stalled/dead/死锁/漂移只落 `reports/` + 事件留痕，引擎绝不自动重跑任务——重派走 `tm_task_action` 人裁。
- **事实源 = 图快照 + 事件流**：`state.json` 是可重建投影，重启即重放重建（含人裁动作）。
- **派发需要属主会话在场**：任务包经 `subagents.startActivation` 投递，要求属主（注册图的会话）的 agent 存活；属主窗口关闭期间投递降级（degraded），属主回来后 `tm_engine_start` 恢复。
- **机械核验**：`{ verify: "mechanical", file }` 查存在性、`{ verify: "mechanical", command }` 看退出码（异步执行、30s 超时，基准目录是交卷会话的工作目录）。

## 开发

```bash
pnpm install
pnpm test        # node --test（129 用例）
pnpm typecheck   # tsc --noEmit
pnpm build       # tsdown → dist/index.mjs
```

依赖 `@deepseek-ai/dsh-tools` 固定为 `0.2.1-rc.2`——工具契约（defineTool 的 output 形状、参数规范化）按该版本核对过，升级前需对照宿主重核。

## 安装

作为 bundle 安装到 DSH profile（`dsh.bundle.patch` 指向 `cordis.patch.yml`）：经 Plugin Manager / `plugin_manager install_bundle` 安装，重启或 HMR 后 `tm_*` 工具在册。
