// Boot 五步自举（FR-15/FR-23）：宿主唤起 + enabled 开关 + 固定五步，无手动启动入口。
//   ① 加载配置（节拍/TTL/并发/gate 切面，含钳制）
//   ② 单写者锁 + 扫描图库校验元数据（meta 损坏 = 拒绝启动，不猜生命周期——
//      deregistered 绝不能被重建诈尸；这与 schedule 的 fail-fast 先例一致）
//   ③ 图快照 + 事件流重建状态投影（不信任 state.json）
//   ④ 绑定台账逐 run 处置：已交卷补验收 / 活着重挂探活 / 死了标 stalled 报人
//   ⑤ 返回装配好的引擎（心跳循环由宿主定时器驱动 reconcileAll）
//
// 开关语义（NFR-3）：enabled=false 时不持锁、不自举、不重建，但**仍装配读写核心模块**
// （store/binder/gate/ctl/acceptor）——tm_* 的注册/改图/视图/交卷/人裁照常可用，只是不派发不探活。

import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { rebuildProjection } from "./rebuild.ts";
import { SingleWriterLock } from "../persister/lock.ts";
import { atomicWriteFileSync } from "../persister/atomic-write.ts";
import { readProjection } from "../persister/projection-store.ts";
import { EventLog } from "../persister/event-log.ts";
import { GraphStore } from "../graph-store/graph-store.ts";
import { Binder } from "../binder/binder.ts";
import { Gate } from "../gate/gate.ts";
import { Deliverer } from "../deliverer/deliverer.ts";
import { Acceptor } from "../acceptor/acceptor.ts";
import { Monitor } from "../monitor/monitor.ts";
import { Reconciler } from "../reconciler/reconciler.ts";
import { GraphCtl } from "../lifecycle/graph-ctl.ts";
import { EngineGuard } from "./guard.ts";

export class BootRefusedError extends Error {
  code: string;
  constructor(reason) {
    super(`boot refused: ${reason}`);
    this.code = "boot-refused";
  }
}

/**
 * @param dataRoot 数据根
 * @param opts { channels, adapters: { activityOf?, processAlive?, fetchResult? }, notifier?, cwd?, now? }
 *   fetchResult(binding) → { evidence } | null：执行者在我们停机期间已交卷（补验收的输入）
 * @returns { disabled: true, ...core } 或装配好的引擎对象（含 reattachReport）
 */
export async function boot(dataRoot, { channels = {}, adapters = {}, notifier = null, cwd, now = new Date() }: any = {}) {
  // ① 配置
  const config = loadConfig(dataRoot);

  const store = new GraphStore(dataRoot);

  // ② 锁 + 扫图校验元数据（仅启用态：关闭态不参与派发，也就不占单写者锁）
  let lock: any = null;
  if (config.enabled) {
    lock = new SingleWriterLock(join(dataRoot, ".engine.lock"), { staleMs: Math.max(config.beatMs * 6, 30_000) });
    const acquired = lock.acquire(); // 持锁失败 = engine-lock-held（NFR-4 红线）
    if (acquired?.tookOverStale) {
      // 接管猝死锁要留痕（原设计承诺「接管动作本身留痕可查」）
      atomicWriteFileSync(
        join(dataRoot, "reports", `${now.toISOString().replaceAll(":", "-")}-lock-takeover.json`),
        JSON.stringify({ kind: "lock-takeover", at: now.toISOString(), note: "前任持锁进程已死，本次接管" }, null, 2),
      );
    }
    for (const graphId of store.list()) {
      try {
        store.meta(graphId);
      } catch (e: any) {
        lock.release();
        throw new BootRefusedError(`图 ${graphId} 元数据损坏（${e.message}）——拒绝猜生命周期，请人工修复 meta.json`);
      }
    }

    // ③ 重建投影（快照 + 事件重放；幂等：重建结果与现存一致也无妨）
    for (const graphId of store.list()) {
      const graph = store.get(graphId);
      const events = EventLog.open(join(dataRoot, "events", `${graphId}.events.ndjson`)).readAll();
      const statusMap = rebuildProjection(graph, events);
      const statePath = join(dataRoot, "state", `${graphId}.state.json`);
      const cur = readProjection(statePath);
      atomicWriteFileSync(statePath, JSON.stringify({ version: cur.version + 1, data: statusMap }));
    }
  }

  // 读写核心模块：与开关无关（tm_* 在 enabled=false 时照常读写）
  const binder = new Binder(dataRoot);
  const gate = new Gate(dataRoot);
  const acceptor = new Acceptor(dataRoot, { binder, cwd: cwd ?? dataRoot, notifier });
  const ctl = new GraphCtl(dataRoot, { store, binder });

  if (!config.enabled) {
    return { disabled: true, config, dataRoot, store, binder, gate, acceptor, ctl };
  }

  const guard = new EngineGuard(dataRoot);
  const deliverer = new Deliverer(dataRoot, { channels, binder });
  const monitor = new Monitor(dataRoot, { binder, adapters, silentMs: config.silentMs });
  const reconciler = new Reconciler(dataRoot, { store, binder, gate, deliverer, monitor, autoFacets: config.autoFacets, guard, concurrency: config.concurrency });

  // ④ 在途逐 run 处置
  const reattach: any = { resubmitted: [], reattached: [], stalled: [] };
  for (const b of binder.active()) {
    const sub = await adapters.fetchResult?.(b);
    if (sub) {
      // 已交卷补验收：用派发时的图版本快照核验
      try {
        const graph = store.get(b.graphId, b.graphVersion);
        await acceptor.submit({ graphId: b.graphId, graph, taskId: b.taskId, runId: b.runId, evidence: sub.evidence ?? {} });
        reattach.resubmitted.push(b.taskId);
        continue;
      } catch {
        // 补验收不过（证据不足等）→ 按活着重挂，等执行者补证据
        reattach.reattached.push(b.taskId);
        continue;
      }
    }
    if (adapters.processAlive?.(b.sessionId) === false) {
      // 死了标 stalled 报人（只报不修）。
      // 去重：liveness 持久化在台账里，已报过 stalled 的绑定重启不再重复写事件/报告
      // （否则 blocked/stalled 长挂任务每重启一次就刷一份报告——审核发现的噪音点）。
      if (b.liveness !== "stalled") {
        binder.markLiveness(b.graphId, b.taskId, { liveness: "stalled" });
        EventLog.open(join(dataRoot, "events", `${b.graphId}.events.ndjson`)).append("stall", {
          taskId: b.taskId,
          runId: b.runId,
          note: "boot-reattach: process gone",
        });
        atomicWriteFileSync(
          join(dataRoot, "reports", `${now.toISOString().replaceAll(":", "-")}-stalled-${b.taskId}.json`),
          JSON.stringify({ kind: "stalled", graphId: b.graphId, taskId: b.taskId, runId: b.runId, note: "boot 重挂时进程已消失", at: now.toISOString() }, null, 2),
        );
      }
      reattach.stalled.push(b.taskId);
    } else {
      reattach.reattached.push(b.taskId); // 活着：重挂探活（适配器已就位，monitor 下拍接管）
    }
  }

  // ⑤ 引擎就绪（心跳由宿主驱动）
  return {
    disabled: false,
    config,
    dataRoot,
    lock,
    store,
    binder,
    gate,
    guard,
    deliverer,
    acceptor,
    monitor,
    reconciler,
    ctl,
    bootReport: { rebuilt: store.list(), reattach },
  };
}
