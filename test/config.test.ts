// config 单元测试（cfg-auto-resume）：autoResume 缺省值 / 显式开关 / 钳制
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULT_CONFIG } from "../src/engine/config.ts";

function scratch(yaml?: string) {
  const dir = mkdtempSync(join(tmpdir(), "tm-config-"));
  if (yaml !== undefined) writeFileSync(join(dir, "config.yaml"), yaml);
  return dir;
}

test("无 config.yaml：autoResume 取缺省 { enabled: false, maxPerTask: 2 }", () => {
  const cfg = loadConfig(scratch());
  assert.deepEqual(cfg.autoResume, { enabled: false, maxPerTask: 2 });
  assert.equal(DEFAULT_CONFIG.autoResume.enabled, false);
  assert.equal(DEFAULT_CONFIG.autoResume.maxPerTask, 2);
});

test("缺省关闭不改变现状行为：其他字段照旧", () => {
  const cfg = loadConfig(scratch());
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.beatMs, 5_000);
  assert.equal(cfg.concurrency, 8);
});

test("显式打开：enabled: true 生效", () => {
  const cfg = loadConfig(scratch("autoResume:\n  enabled: true\n"));
  assert.deepEqual(cfg.autoResume, { enabled: true, maxPerTask: 2 });
});

test("显式关闭：enabled: false 覆盖（false 即关闭，不存在三态）", () => {
  const cfg = loadConfig(scratch("autoResume:\n  enabled: false\n  maxPerTask: 5\n"));
  assert.deepEqual(cfg.autoResume, { enabled: false, maxPerTask: 5 });
});

test("maxPerTask 钳制 0..8：超界收敛到边界", () => {
  assert.equal(loadConfig(scratch("autoResume:\n  maxPerTask: 99\n")).autoResume.maxPerTask, 8);
  assert.equal(loadConfig(scratch("autoResume:\n  maxPerTask: -3\n")).autoResume.maxPerTask, 0);
  assert.equal(loadConfig(scratch("autoResume:\n  maxPerTask: 8\n")).autoResume.maxPerTask, 8);
  assert.equal(loadConfig(scratch("autoResume:\n  maxPerTask: 0\n")).autoResume.maxPerTask, 0);
});

test("maxPerTask 非数字/缺失 → 缺省 2；小数取整", () => {
  assert.equal(loadConfig(scratch("autoResume:\n  enabled: true\n")).autoResume.maxPerTask, 2);
  assert.equal(loadConfig(scratch("autoResume:\n  maxPerTask: \"abc\"\n")).autoResume.maxPerTask, 2);
  assert.equal(loadConfig(scratch("autoResume:\n  maxPerTask: 3.7\n")).autoResume.maxPerTask, 3);
});

test("autoResume 非对象（标量/数组）→ 回退缺省", () => {
  assert.deepEqual(loadConfig(scratch("autoResume: true\n")).autoResume, { enabled: false, maxPerTask: 2 });
  assert.deepEqual(loadConfig(scratch("autoResume:\n  - 1\n")).autoResume, { enabled: false, maxPerTask: 2 });
});
