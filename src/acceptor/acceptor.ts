// 完成验收（FR-6 / IF-3）：执行者唯一回向接口。
// 纪律：
//   - 世代先行：runId 必须等于台账当前世代（stale-run 拒收）；
//   - checks 逐条核验：mechanical 白名单可执行（file=存在性 / command=退出码），
//     human 必须附非空证据；任一不过 → evidence-insufficient 打回，状态不变；
//   - 过 → CAS 翻 done → 关绑定 → append accept（级联解锁是 reconciler 的事）；
//   - 幂等：同一 runId 重复交卷，已 done 则幂等返回"已验收"，不重复级联；
//   - blocked → 状态翻 blocked + 上报落盘（reports/），等人裁（只报不修）。

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readProjection, casWriteProjection } from "../persister/projection-store.ts";
import { atomicWriteFileSync } from "../persister/atomic-write.ts";
import { EventLog } from "../persister/event-log.ts";

export class NotRunningError extends Error {
  code: string;
  constructor(taskId, status) {
    super(`task ${taskId} not running (status=${status})`);
    this.code = "not-running";
  }
}

export class EvidenceInsufficientError extends Error {
  code: string;
  missing: string[];
  constructor(taskId, missing) {
    super(`evidence insufficient for ${taskId}: ${missing.join("；")}`);
    this.code = "evidence-insufficient";
    this.missing = missing;
  }
}

/** 机械核验白名单：{ verify:"mechanical", file } 存在性；{ verify:"mechanical", command } 退出码 */
function verifyMechanical(check, { cwd, runner }: any) {
  if (check.file) return existsSync(join(cwd, check.file));
  if (check.command) {
    const run = runner ?? ((cmd, dir) => execFileSync("sh", ["-c", cmd], { cwd: dir, stdio: "pipe", timeout: 30_000 }));
    try {
      run(check.command, cwd);
      return true;
    } catch {
      return false;
    }
  }
  return false; // mechanical 但无可执行形式 = 白名单外，判不过
}

/** 规范化 check：string → human；对象 → { text, verify, file?, command? } */
function normalizeCheck(c) {
  return typeof c === "string" ? { text: c, verify: "human" } : c;
}

export class Acceptor {
  dataRoot: string;
  binder: any;
  cwd: string;
  notifier: any;
  runner: any;
  /**
   * @param dataRoot 数据根
   * @param binder Binder 实例
   * @param cwd 工作区根（机械核验的相对路径基准）
   * @param notifier 打回通知适配器 async (sessionId, message) => {}（经 sendMessage 寻址）
   * @param runner 命令执行器（测试注入）
   */
  constructor(dataRoot: any, { binder, cwd, notifier = null, runner = null }: any = {}) {
    this.dataRoot = dataRoot;
    this.binder = binder;
    this.cwd = cwd;
    this.notifier = notifier;
    this.runner = runner;
  }

  #statePath(graphId) {
    return join(this.dataRoot, "state", `${graphId}.state.json`);
  }

  #eventLog(graphId) {
    return EventLog.open(join(this.dataRoot, "events", `${graphId}.events.ndjson`));
  }

  /**
   * 交卷（IF-3）。
   * @param graph 派发时的图快照（任务定义来源）
   * @param submission { runId, taskId, evidence: { [checkIndex]: string }, cwd? }（cwd = 执行者工作目录，机械核验的基准）
   * @returns {{ accepted: true, idempotent?: boolean } }
   * @throws StaleRunError 世代失效；NotRunningError 非 running；EvidenceInsufficientError 打回
   */
  async submit({ graphId, graph, taskId, runId, evidence = {}, cwd }: any, now = new Date()) {
    const events = this.#eventLog(graphId);
    const statePath = this.#statePath(graphId);
    const proj = readProjection(statePath);
    const entry = proj.data?.[taskId];
    const status = entry?.status ?? "pending";

    // 幂等：已 done 且 runId 与完成它的世代一致 → 幂等返回（IF-3）
    if (status === "done" && entry.runId === runId) {
      return { accepted: true, idempotent: true };
    }
    if (status !== "running") throw new NotRunningError(taskId, status);

    // 世代校验（stale-run 由 binder 抛）
    this.binder.assertCurrent(taskId, runId);

    const task = graph.tasks.find((t) => t.id === taskId);
    const checks = task.checks.map(normalizeCheck);
    const missing: any[] = [];
    checks.forEach((check, i) => {
      if (check.verify === "mechanical") {
        // 机械核验必须跑在执行者的工作目录（调用方传入），否则命令会在宿主进程 cwd 里执行
        if (!verifyMechanical(check, { cwd: cwd ?? this.cwd, runner: this.runner })) {
          missing.push(`checks[${i}]「${check.text}」机械核验未通过`);
        }
      } else if (typeof evidence[i] !== "string" || !evidence[i].trim()) {
        missing.push(`checks[${i}]「${check.text}」缺证据`);
      }
    });

    if (missing.length > 0) {
      // 打回：状态不变，事件留痕，经绑定 sessionId 通知执行者补证据
      events.append("reject", { taskId, runId, missing });
      const binding = this.binder.byTask(taskId);
      if (this.notifier && binding) {
        // 通知是尽力而为：sendMessage 失败（属主不在场/宿主契约变化）不能吞掉打回语义，
        // 否则调用方拿到的是通知异常而不是 evidence-insufficient。
        try {
          await this.notifier(binding.sessionId, `交卷被打回（${this.#planRef(entry)}）：\n${missing.map((m) => `- ${m}`).join("\n")}\n请补齐后重新交卷。`);
        } catch {
          /* 打回事件已留痕，忽略通知失败 */
        }
      }
      throw new EvidenceInsufficientError(taskId, missing);
    }

    // 验收通过：CAS running→done → 关绑定 → accept 事件
    casWriteProjection(statePath, proj.version, {
      ...proj.data,
      [taskId]: { ...entry, status: "done", doneAt: now.toISOString() },
    });
    this.binder.close(taskId, { outcome: "done" });
    events.append("accept", { taskId, runId });
    return { accepted: true };
  }

  /**
   * 执行者报 blocked（IF-3 另一支）：状态翻 blocked + 上报落盘，等人裁。引擎零自动动作。
   */
  async reportBlocked({ graphId, taskId, runId, reason }, now = new Date()) {
    const events = this.#eventLog(graphId);
    const statePath = this.#statePath(graphId);
    const proj = readProjection(statePath);
    const entry = proj.data?.[taskId];
    if ((entry?.status ?? "pending") !== "running") throw new NotRunningError(taskId, entry?.status ?? "pending");
    this.binder.assertCurrent(taskId, runId);
    casWriteProjection(statePath, proj.version, {
      ...proj.data,
      [taskId]: { ...entry, status: "blocked", blockedAt: now.toISOString(), blockReason: reason ?? null },
    });
    events.append("blocked", { taskId, runId, reason: reason ?? null });
    // 上报落盘（R-8 只报不修）
    atomicWriteFileSync(
      join(this.dataRoot, "reports", `${now.toISOString().replaceAll(":", "-")}-blocked-${taskId}.json`),
      JSON.stringify({ kind: "blocked", graphId, taskId, runId, reason: reason ?? null, at: now.toISOString() }, null, 2),
    );
    return { reported: true };
  }

  #planRef(entry) {
    return entry?.runId ? `runId ${entry.runId}` : "在途任务";
  }
}
