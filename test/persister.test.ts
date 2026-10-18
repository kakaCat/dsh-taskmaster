// persister 单元测试（S1 工作项 #1，覆盖需求 NFR-5 / 设计 persister 模块）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "../src/persister/atomic-write.ts";
import { SingleWriterLock, LockHeldError } from "../src/persister/lock.ts";
import { EventLog } from "../src/persister/event-log.ts";
import { readProjection, casWriteProjection, WriteConflictError } from "../src/persister/projection-store.ts";

function scratch() {
  return mkdtempSync(join(tmpdir(), "tm-persister-"));
}

test("原子写：内容正确、无临时文件残留、自动建目录", () => {
  const dir = scratch();
  const p = join(dir, "a/b/c.json");
  atomicWriteFileSync(p, JSON.stringify({ ok: 1 }));
  assert.equal(JSON.parse(readFileSync(p, "utf8")).ok, 1);
  const leftovers = readdirSync(join(dir, "a/b")).filter((f) => f.endsWith(".tmp"));
  assert.equal(leftovers.length, 0);
});

test("单写者锁：二写者被拒（engine-lock-held）", () => {
  const dir = scratch();
  const p = join(dir, ".engine.lock");
  const a = new SingleWriterLock(p);
  assert.equal(a.acquire().acquired, true);
  const b = new SingleWriterLock(p);
  assert.throws(() => b.acquire(), (e) => e instanceof LockHeldError && e.code === "engine-lock-held");
  a.release();
});

test("单写者锁：释放后可再获取；非持有者不能释放别人的锁", () => {
  const dir = scratch();
  const p = join(dir, ".engine.lock");
  const a = new SingleWriterLock(p);
  a.acquire();
  const b = new SingleWriterLock(p);
  b.release(); // b 未持有，不得误删 a 的锁
  assert.equal(existsSync(p), true);
  a.release();
  assert.equal(existsSync(p), false);
  const c = new SingleWriterLock(p);
  assert.equal(c.acquire().acquired, true);
  c.release();
});

test("单写者锁：猝死锁（mtime 超 staleMs）可被接管", () => {
  const dir = scratch();
  const p = join(dir, ".engine.lock");
  const a = new SingleWriterLock(p, { staleMs: 1000 });
  a.acquire();
  // 模拟猝死：不 release，把 mtime 拨到 10 秒前
  const old = new Date(Date.now() - 10_000);
  utimesSync(p, old, old);
  const b = new SingleWriterLock(p, { staleMs: 1000 });
  const r = b.acquire();
  assert.equal(r.acquired, true);
  assert.equal(r.tookOverStale, true);
  b.release();
});

test("单写者锁：持有进程已死（PID 探测）→ 立即接管，不等 mtime TTL", () => {
  const dir = scratch();
  const p = join(dir, ".engine.lock");
  // 伪造一个死 PID 的锁文件（mtime 很新，但进程不存在）
  writeFileSync(p, JSON.stringify({ pid: 999999, token: "dead:1", acquiredAt: new Date().toISOString() }));
  const lock = new SingleWriterLock(p, { staleMs: 60_000 });
  const r = lock.acquire();
  assert.equal(r.acquired, true);
  assert.equal((r as any).tookOverStale, true);
  lock.release();
});

test("事件流：seq 单调递增；重开后续号；崩溃半行不炸", () => {
  const dir = scratch();
  const p = join(dir, "events/g1.events.ndjson");
  const log = EventLog.open(p);
  const e1 = log.append("register", { graphId: "g1" });
  const e2 = log.append("dispatch", { taskId: "t-1" });
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  // 模拟崩溃截断：追加半行坏 JSON
  atomicWriteFileSync(p, readFileSync(p, "utf8") + `{"seq": 3, "kind": "inc`);
  const reopened = EventLog.open(p);
  assert.equal(reopened.lastSeq, 2); // 坏行跳过，不污染 seq
  const e3 = reopened.append("accept", { taskId: "t-1" });
  assert.equal(e3.seq, 3);
  assert.equal(reopened.readAll().length, 3);
});

test("投影 CAS：期望版本不符拒绝；首次写入从 v0 到 v1", () => {
  const dir = scratch();
  const p = join(dir, "state/g1.state.json");
  assert.deepEqual(readProjection(p), { version: 0, data: null });
  casWriteProjection(p, 0, { "t-1": { status: "pending" } });
  assert.equal(readProjection(p).version, 1);
  // 用旧版本写 → 冲突
  assert.throws(
    () => casWriteProjection(p, 0, {}),
    (e) => e instanceof WriteConflictError && e.code === "write-conflict",
  );
  // 用当前版本写 → 成功到 v2
  casWriteProjection(p, 1, { "t-1": { status: "done" } });
  assert.equal(readProjection(p).data["t-1"].status, "done");
});
