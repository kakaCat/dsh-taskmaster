// 配置加载（config.yaml）：节拍/TTL/并发/gate 切面 + enabled 总开关。
// 工作假设（S0 豁免留痕）：节拍全局默认，配置结构预留图级字段（图级覆盖 S2 再说）。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

export const DEFAULT_CONFIG = {
  enabled: false, // 总开关：缺省关闭（NFR-3）
  beatMs: 5_000, // 心跳节拍（全局默认；钳制见下）
  silentMs: 90_000, // 探活 TTL：沉默超此 → stalled
  concurrency: 1, // S1 固定 1（串行派发）
  autoFacets: [], // gate=auto 里程碑切面
};

const LIMITS = {
  beatMs: [1_000, 300_000], // 上下限钳制：1s ~ 5min
  silentMs: [10_000, 3_600_000],
  concurrency: [1, 1], // S1 锁死 1，S2 放开
};

export function loadConfig(dataRoot) {
  const p = join(dataRoot, "config.yaml");
  const raw = existsSync(p) ? (yaml.load(readFileSync(p, "utf8")) ?? {}) : {};
  const cfg = { ...DEFAULT_CONFIG, ...raw };
  for (const [key, [lo, hi]] of Object.entries(LIMITS)) {
    if (typeof cfg[key] === "number") cfg[key] = Math.min(hi, Math.max(lo, cfg[key]));
  }
  if (!Array.isArray(cfg.autoFacets)) cfg.autoFacets = [];
  return cfg;
}
