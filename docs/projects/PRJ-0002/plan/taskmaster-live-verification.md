# dsh-taskmaster 真机验证报告

> 验证对象：`dsh-taskmaster` 宿主插件在 **DSH 桌面应用真实 composition** 中的行为（非 mock）。
> 判定原则：mock 全绿不算通过；**真宿主行为是唯一验收门**。
> 数据根：`~/.dsh/storages/dsh-taskmaster`（宿主进程内引擎实数据）。

## 1. 结论

8 个 `tm_*` 工具在真宿主全部可用，端到端「注册 → 计划卡 → 确认 → 派发 → 交卷 → 收口」真实跑通，并修复了 v0.8 之后仍残留的**启动期竞态导致永久降级**问题。

| 项 | 结果 |
|---|---|
| 工具挂载 | 8/8（`tm_upsert` `tm_confirm` `tm_node_update` `tm_status` `tm_graph_ctl` `tm_task_action` `tm_engine_stop` `tm_engine_start`） |
| 输出契约 | 全部 lossless JSON（早期 `tool returned invalid output` 已消除） |
| 真实派发 | ✅ `channel=startActivation`，子会话真实执行并交卷 |
| 启动期竞态 | ✅ 冷启动首拍撞竞态 → 延迟 → 下一拍补投递成功，**零降级** |
| 单写者锁 | ✅ 活进程锁不再被误抢；每拍刷新 mtime |
| 测试 | 118/118 + `tsc --noEmit` 0 错 |
| 构建 | `dist/index.mjs` 87.79 kB |

## 2. 真机暴露并修复的问题

### P1 错误返回触发宿主输出契约（最致命）
`tm_*` 错误分支返回 `issues: e.issues`，值 `undefined` 时真宿主 `dsh-tools` 判 `value is not lossless JSON`，把**所有**错误码统一替换成 `tool returned invalid output`——工具自身语义全被抹掉。
**修复**：`errorResult()` 仅在字段有定义时携带 `issues` / `missing`。

### P2 三条通道全 unavailable
`apply` 阶段就把 `ctx.get("subagents")` 快照存下，此时服务 fiber 还没 active → 三档通道全部报告不可用。
**修复**：服务改**每次调用内惰性解析**（`ctx.get` 严格语义：只认 `state === 2` 的提供者 fiber）。

### P3 `provider: "default"` 不存在
宿主只注册 `"spawn"` 与 `"fork"`。
**修复**：`startActivation` 通道 → `spawn`，`spawn` 通道 → `fork`。

### P4 请求契约不符
`startActivation` 缺 `signal`、`request.prompt` 需 `ContentBlock[]`、`label` 必填（缺 `label` 时真宿主报 `subagent descriptor is not losslessly JSON-serializable`）；`sendMessage` 需 `ContentBlock[]` + `{ signal }`。
**修复**：按宿主契约逐项补齐。

### P5 活锁被误抢
旧逻辑 `pidAlive && !staleByTime → throw`，结果活进程的锁在 30s 后仍被接管（`tookOverStale: true`）。
**修复**：有 pid 且进程存活 → **永不接管**；死 pid → 立即接管；无 pid → 才看 mtime；每拍 `lock.heartbeat()` 刷新。

### P6 `enabled: false` 全工具报内部错
`tm_status` → `Cannot read properties of undefined (reading 'dataRoot')`；`tm_upsert` → `...reading 'upsert'`。
**修复**：`enabled=false` 时返回 `BootCore`（store/binder/gate/ctl/acceptor 照常装配），读写可用、只是不派发不探活。

### P7（v0.9，最后一处）启动期竞态 → **永久降级**
心跳首拍可能早于 `subagents` 服务 active：投递失败 → `markDegraded("all-channels-down")` → 此后所有派发被 `engine.degraded` 拦下且**不自愈**，只能人工 `tm_engine_start`。
**根因**：「执行面还没起来」（暂时）与「执行面根本没有」（永久）走了同一条失败路径。

**修复三层**：

1. **可延迟错误**：新增 `DeliveryDeferredError`（`code: "delivery-deferred"`）。
2. **就绪探测** `src/host/channels.ts`：
   - `available()` = `subagentsReady() || windowReady()`
   - `pending()` 只在**真·暂时态**返回 `true`：
     - 服务 impl 已注册但 `fiber.state !== 2`（注册了还没 active）；
     - 服务 active 但 `getProvider("spawn"|"fork")` 都还没注册；
     - 启动宽限 `STARTUP_GRACE_MS = 20s` 内执行面尚未出现。
   - 宽限过后仍无执行面 → `pending() = false` → 照旧 `DeliveryFailed` 降级（**永久不存在要显式报警**，不静默吞）。
   - 关键副作用：`window.openBranch` 在本 composition 中**永久不存在**，故不能被误判为暂时。
3. **投递器步骤 ⓪**（`src/deliverer/deliverer.ts`）：在 CAS 占位（`ready → dispatching`）**之前**先问 `available()`；未就绪且 `pending()` → 抛 `DeliveryDeferredError` → **零占位、零绑定、零失败留痕**，任务留在 `ready`。
4. **reconciler 两处 catch**（补投递 / 新批次）先认延迟（记 `delivery-deferred:<taskId>`）再认失败：延迟不降级、不写 failed run，下一拍自然重试。

## 3. 真机证据链（P7 冷启动竞态，重启窗口内）

准备：`tm_upsert` 建单任务图 → 心跳出计划卡 → **`tm_engine_stop`（停机期零派发）** → `tm_confirm`。
此时磁盘状态 `boot-race: ready`、`bindings: []`，其后 6s 无 dispatch —— 现场构造完毕。

| 时刻（UTC） | 事件 | 判读 |
|---|---|---|
| 17:41:40.631 | `plan-confirmed` | 引擎已停，确认落盘但不派发 |
| 17:42:06.260 | 引擎取 `.engine.lock`（进程 18253 重启完成） | 冷启动，`subagents` 尚未 active |
| 17:42:11.321 | `dispatch` `channel=startActivation` (run `r-mve44spa-dcb6d6`) | **锁后恰好 1 个 beat（5.015s）** → 首拍被延迟逻辑接管，下一拍补投递成功 |
| 17:43:41.669 | `accept` | 执行者 `tm_node_update` 返 `{"ok":true,"accepted":true}` |
| 17:43:46.291 | `graph-asleep` | 图 `active → asleep` |

**反证**：
- 该图 `runs/failed/` 下**零**记录（仅存另一张旧图的 e2e 失败留痕）；
- `engine = {enabled:true, degraded:false, degradedReason:null, stopped:false, heartbeat:true}`；
- 旧图 `g-mve3vn4x-ac3344` 在修复前留下 `delivery-failed` ×2（seq5/seq6）—— 同一现象在 v0.9 下不再出现。

成功投递留痕 `runs/r-mve44spa-dcb6d6/delivery.json`：

```json
{
  "graphId": "g-mve43wkl-addfba",
  "taskId": "boot-race",
  "runId": "r-mve44spa-dcb6d6",
  "attempts": [{ "channel": "startActivation", "ok": true }],
  "result": "delivered",
  "channel": "startActivation",
  "sessionId": "23b4b9b4-7107-4dd5-867d-e30da09adda6",
  "at": "2026-10-18T17:42:11.275Z"
}
```

执行者独立复核（其自身会话 ID 与绑定记录一致）确认：任务包实际送达、checks 与图 v1 一致、未修改任何文件。

## 4. 回归测试

| 测试文件 | 覆盖 |
|---|---|
| `test/tools-contract.test.ts` | 8 工具的 lossless JSON 输出契约（含各错误码） |
| `test/host-integration.test.ts` | 严格宿主 mock + `lateSubagents` 迟到服务 + 通知契约 |
| `test/channels.test.ts`（新增） | 就绪探测四态：服务未注册 / fiber 未 active / active+provider / active 无 provider |
| `test/deliverer.test.ts`（新增 2 例） | 延迟路径⇒零占位零留痕；非 pending 的缺失⇒仍 `DeliveryFailedError` |
| `test/reconciler.test.ts`（新增 1 例） | 装配级：pending ⇒ `delivery-deferred`、不降级、任务留 `ready`；就绪后下一拍真派发 |
| `test/cordis-smoke.test.ts` | 真实 cordis Context + 插件协议 + `ctx.effect` 心跳托管 |

`npx tsc --noEmit` → 0 错；`npm test` → **118/118 pass**。

## 5. 尚存边界（已知、非缺陷）

- **`DeliveryDeferredError` 只从投递器步骤 ⓪ 抛出**：走到通道循环说明 `available()` 已为 true，此时失败是真失败 → 仍 `DeliveryFailed` 降级（语义正确）。
- **`enabled: false` 不取 `engine.lock`**：禁用态不派发、不探活，无需单写者互斥。
- **`branch` 通道在本 composition 永久不可用**（`window.openBranch` 不存在）：真实派发走 `startActivation`；`pending()` 已按「永久不存在」处理，不会因此卡住派发。
- **`tm_engine_stop/start` 未加权限门**：引擎级运维开关，当前仅会话内 agent 可调；是否需要额外门禁待需求方裁决。
