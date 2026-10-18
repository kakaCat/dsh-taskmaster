// 状态投影存取：{ version, data } 信封 + 版本 CAS。
// 纪律：state.json 是可重建投影（崩了不心疼），但并发写仍走 CAS——
// 读到的版本不等于期望值就拒绝，防单写者锁失效时的最后防线。

import { readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";

export class WriteConflictError extends Error {
  constructor(path, expected, actual) {
    super(`projection write conflict: ${path} (expected v${expected}, actual v${actual})`);
    this.code = "write-conflict";
  }
}

/** @returns {{ version: number, data: any }} 文件不存在时 version=0, data=null */
export function readProjection(path) {
  if (!existsSync(path)) return { version: 0, data: null };
  const envelope = JSON.parse(readFileSync(path, "utf8"));
  return { version: envelope.version ?? 0, data: envelope.data ?? null };
}

/**
 * CAS 写：当前版本必须等于 expectedVersion，否则 WriteConflictError。
 * @returns 写入后的新版本号
 */
export function casWriteProjection(path, expectedVersion, data) {
  const current = readProjection(path).version;
  if (current !== expectedVersion) throw new WriteConflictError(path, expectedVersion, current);
  const next = current + 1;
  atomicWriteFileSync(path, JSON.stringify({ version: next, data }));
  return next;
}
