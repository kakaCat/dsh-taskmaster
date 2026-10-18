// 单写者锁：.engine.lock
// 红线见需求 NFR-4 / R-22：同一数据根只允许一个引擎写。
// 锁文件含 pid + token + 时间戳；每拍 heartbeat 刷新 mtime；
// 锁超时（holder 猝死未释放）可被接管，接管动作本身留痕可查。

import { openSync, closeSync, writeFileSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";

export class LockHeldError extends Error {
  code: string;
  holder: any;
  constructor(path, holder) {
    super(`engine lock held: ${path} (holder: ${JSON.stringify(holder)})`);
    this.code = "engine-lock-held";
    this.holder = holder;
  }
}

export class SingleWriterLock {
  path: string;
  staleMs: number;
  token: string | null;
  /** @param staleMs 锁 mtime 超过该毫秒数未刷新即视为前任猝死，可接管 */
  constructor(path, { staleMs = 30_000 }: any = {}) {
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
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      // 锁已存在：判猝死。
      // 铁律（NFR-4）：持有进程**活着**就绝不接管——mtime 过期只能说明心跳没刷，
      // 不能证明进程死了（旧逻辑 pidAlive && !stale 才拒绝，导致活锁 30s 后被抢）。
      //   · 有 pid 且进程存活 → 直接 engine-lock-held；
      //   · 有 pid 且进程已死 → 立即接管；
      //   · 无 pid（旧格式/坏文件）→ 只能退回 mtime：新则拒绝、过期才接管。
      const holder = safeRead(this.path);
      const hasPid = typeof holder?.pid === "number" && holder.pid > 0;
      if (hasPid && isPidAlive(holder.pid)) throw new LockHeldError(this.path, holder);
      const stat = statSync(this.path);
      const staleByTime = now - stat.mtimeMs > this.staleMs;
      if (!hasPid && !staleByTime) throw new LockHeldError(this.path, holder);
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

/** 持有进程是否存活（挂掉即可立即接管，不必等 mtime TTL） */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM"; // 权限不足 = 进程存在；ESRCH = 已死
  }
}

function safeRead(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
