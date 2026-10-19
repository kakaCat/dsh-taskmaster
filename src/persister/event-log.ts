import type { EventRecord } from "../types.ts";

// 事件流：append-only NDJSON，seq 单调递增。
// 纪律见设计文档数据模型节：事件流是事实源之一；seq 同时是探活的"留痕心跳"信号。

import { readFileSync, appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

export class EventLog {
  path: string;
  lastSeq: number;
  tornTail: boolean;
  /** 上次观察到的文件指纹（append 后维护）；open 时用它判断要不要重扫 */
  lastSize: number = -1;
  lastMtimeMs: number = -1;

  /** 进程内缓存：事件流是高频写路径，每次 open 全文件重扫在长图上是 O(n²)（审核发现）。
   *  指纹（size+mtime）不符才重扫——外部改动（如崩溃半行修复）不会吃到陈旧 lastSeq。 */
  static #cache = new Map<string, EventLog>();

  /** 打开（不存在则视为空）。首次/外部变更时扫描全量拿到 lastSeq，并检测尾部坏行（崩溃截断）。 */
  static open(path) {
    const stat = existsSync(path) ? statSync(path) : null;
    const size = stat?.size ?? 0;
    const mtimeMs = stat?.mtimeMs ?? 0;
    const cached = EventLog.#cache.get(path);
    if (cached && cached.lastSize === size && cached.lastMtimeMs === mtimeMs) return cached;

    let lastSeq = 0;
    let tornTail = false;
    if (stat) {
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n");
      // 文件不是以换行结尾 → 最后一行是可疑的截断行
      tornTail = text.length > 0 && !text.endsWith("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const seq = JSON.parse(line).seq;
          if (typeof seq === "number" && seq > lastSeq) lastSeq = seq;
        } catch {
          /* 尾部半行（崩溃截断）：跳过 */
        }
      }
    }
    const log = new EventLog(path, lastSeq, tornTail);
    log.lastSize = size;
    log.lastMtimeMs = mtimeMs;
    EventLog.#cache.set(path, log);
    return log;
  }

  constructor(path, lastSeq, tornTail = false) {
    this.path = path;
    this.lastSeq = lastSeq;
    this.tornTail = tornTail;
  }

  /**
   * 追加一条事件：{ seq, ts, kind, ...fields }。
   * 若上次崩溃留下截断尾行，先补换行隔离坏行，保证新事件完整可读。
   * @returns 写入的事件（含分配的 seq）
   */
  append(kind: string, fields: Record<string, unknown> = {}, now: Date = new Date()): EventRecord {
    mkdirSync(dirname(this.path), { recursive: true });
    const event: EventRecord = { seq: this.lastSeq + 1, ts: now.toISOString(), kind, ...fields };
    appendFileSync(this.path, (this.tornTail ? "\n" : "") + JSON.stringify(event) + "\n");
    this.tornTail = false;
    this.lastSeq = event.seq;
    // 维护指纹，下一次 open 走缓存
    const stat = statSync(this.path);
    this.lastSize = stat.size;
    this.lastMtimeMs = stat.mtimeMs;
    return event;
  }

  /** 全量读回（崩溃重建用；只追加不回改，所以读到的即历史全集）。尾部坏行（崩溃截断）跳过并计数。 */
  readAll(): EventRecord[] {
    if (!existsSync(this.path)) return [];
    const events: any[] = [];
    let torn = 0;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        torn++;
      }
    }
    return Object.assign(events, { torn });
  }
}
