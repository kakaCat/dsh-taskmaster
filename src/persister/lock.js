// 单写者锁：.engine.lock
// 红线见需求 NFR-4 / R-22：同一数据根只允许一个引擎写。
// 锁文件含 pid + token + 时间戳；每拍 heartbeat 刷新 mtime；
// 锁超时（holder 猝死未释放）可被接管，接管动作本身留痕可查。

import { openSync, closeSync, writeFileSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";

export class LockHeldError extends Error {
  constructor(path, holder) {
    super(`engine lock held: ${path} (holder: ${JSON.stringify(holder)})`);
    this.code = "engine-lock-held";
    this.holder = holder;
  }
}

export class SingleWriterLock {
  /** @param staleMs 锁 mtime 超过该毫秒数未刷新即视为前任猝死，可接管 */
  constructor(path, { staleMs = 30_000 } = {}) {
    this.path = path;
    this.staleMs = staleMs;
    this.token = null;
  }

  /** @returns {{ acquired: true, tookOverStale?: boolean }} */
  acquire(now = Date.now()) {
    this.token = `${process.pid}:${now}:${Math.random().toString(36).slice(2, 10)}`;
    const body = JSON.stringify({ pid: process.pid, token: this.token, acquiredAt: new Date(now).toISOString() });
    try {
      const fd = openSync(this.path, "wx");
      writeFileSync(fd, body);
      closeSync(fd);
      return { acquired: true };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // 锁已存在：看是否猝死（mtime 超 staleMs 未刷新）
      const stat = statSync(this.path);
      if (now - stat.mtimeMs <= this.staleMs) {
        throw new LockHeldError(this.path, safeRead(this.path));
      }
      rmSync(this.path); // 接管猝死锁
      const fd = openSync(this.path, "wx");
      writeFileSync(fd, body);
      closeSync(fd);
      return { acquired: true, tookOverStale: true };
    }
  }

  /** 每拍心跳刷新锁 mtime，防止被误判猝死 */
  heartbeat(now = Date.now()) {
    if (!this.token) return;
    try {
      utimesSync(this.path, new Date(now), new Date(now));
    } catch {
      /* 锁文件被外力删除：下一拍对账会发现并拒写 */
    }
  }

  /** 只有自己（token 匹配）能释放 */
  release() {
    if (!this.token) return;
    const holder = safeRead(this.path);
    if (holder?.token === this.token) rmSync(this.path);
    this.token = null;
  }
}

function safeRead(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
