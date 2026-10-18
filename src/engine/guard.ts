// 开关与降级（NFR-3 / FR-12→NFR-3）：引擎的安全阀。
// 纪律：
//   - enabled=false：不派发不探活，读写照常（status/upsert 不受 guard 管辖）；
//   - 配置每拍重读：人改 config.yaml，下一拍生效；
//   - 执行面降级：全部通道不可用 → degraded（纯对话流：只出计划卡，不尝试投递）；
//     degraded 是粘性的——人修好后清标记（或重启），引擎不自己反复撞墙；
//   - 许可分离：allowMonitor（探活）只看 enabled；allowDispatch（派发）看 enabled + 未降级。

import { loadConfig } from "./config.ts";

export class EngineGuard {
  dataRoot: string;
  degraded: boolean;
  degradedReason: string | null;
  degradedAt: string | null = null;
  stopped = false; // 运行态停止（S2 IF-7）：心跳停、零派发零探活、在途不杀、台账保留
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
    this.degraded = false;
    this.degradedReason = null;
  }

  /** 每拍重读配置（小文件，成本可忽略；改配置下一拍生效） */
  get config() {
    return loadConfig(this.dataRoot);
  }

  get enabled() {
    return this.config.enabled;
  }

  /** 探活许可：总开关 + 未运行态停止 */
  allowMonitor() {
    return this.enabled && !this.stopped;
  }

  /** 派发许可：总开关 + 未降级 + 未停止 */
  allowDispatch() {
    return this.enabled && !this.degraded && !this.stopped;
  }

  /** 运行态停止（IF-7）：心跳停/零派发零探活；在途不杀、台账保留；再启动走 Boot ④重挂 */
  stop() {
    this.stopped = true;
  }

  /** 运行态恢复：与 Boot ④等效——在途绑定由下一拍对账重挂 */
  start() {
    this.stopped = false;
  }

  /** 标降级（幂等：已降级不重复记） */
  markDegraded(reason) {
    if (this.degraded) return;
    this.degraded = true;
    this.degradedReason = reason;
    this.degradedAt = new Date().toISOString();
  }

  /** 清降级（人修好后调用，或重启清零——degraded 是内存态，不落盘） */
  clearDegraded() {
    this.degraded = false;
    this.degradedReason = null;
    this.degradedAt = null;
  }
}
