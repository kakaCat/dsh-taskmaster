// 原子写：临时文件 + rename（POSIX 原子替换）。
// 纪律见设计文档数据模型节：所有原地写一律走这里，不许直接 writeFile 覆盖。

import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * 原子地把 content 写到 path（先写同目录临时文件，再 rename 覆盖）。
 * 调用方负责保证单写者（见 SingleWriterLock）。
 */
export function atomicWriteFileSync(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}
