// 事件流：append-only NDJSON，seq 单调递增。
// 纪律见设计文档数据模型节：事件流是事实源之一；seq 同时是探活的"留痕心跳"信号。

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class EventLog {
  /** 打开（不存在则视为空）。打开时扫描全量拿到 lastSeq，并检测尾部坏行（崩溃截断）。 */
  static open(path) {
    let lastSeq = 0;
    let tornTail = false;
    if (existsSync(path)) {
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
    return new EventLog(path, lastSeq, tornTail);
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
  append(kind, fields = {}, now = new Date()) {
    mkdirSync(dirname(this.path), { recursive: true });
    const event = { seq: this.lastSeq + 1, ts: now.toISOString(), kind, ...fields };
    appendFileSync(this.path, (this.tornTail ? "\n" : "") + JSON.stringify(event) + "\n");
    this.tornTail = false;
    this.lastSeq = event.seq;
    return event;
  }

  /** 全量读回（崩溃重建用；只追加不回改，所以读到的即历史全集）。尾部坏行（崩溃截断）跳过并计数。 */
  readAll() {
    if (!existsSync(this.path)) return [];
    const events = [];
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
