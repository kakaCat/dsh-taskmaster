// 图库：注册/改图/回读/版本管理。
// 纪律（FR-1 + NFR-5）：版本快照只增不删；校验失败零落盘；
// meta.json 走投影 CAS（并发改图 = write-conflict）；每次注册/改图 append register 事件。

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import * as yaml from "js-yaml";
import { atomicWriteFileSync } from "../persister/atomic-write.ts";
import { readProjection, casWriteProjection } from "../persister/projection-store.ts";
import { EventLog } from "../persister/event-log.ts";
import { assertValidGraph } from "./validate.ts";
import type { Graph, GraphMeta } from "../types.ts";

export class GraphNotFoundError extends Error {
  code: string;
  graphId: string;
  constructor(graphId) {
    super(`graph not found: ${graphId}`);
    this.code = "graph-not-found";
    this.graphId = graphId;
  }
}

export class BadTransitionError extends Error {
  code: string;
  constructor(graphId, from, to) {
    super(`bad lifecycle transition: ${graphId} ${from} → ${to}`);
    this.code = "bad-transition";
  }
}

/** 图生命周期迁移表（R-17/18/19 状态机底座；人裁入口在 #10，引擎内部迁移在 reconciler） */
export const LIFECYCLE_TRANSITIONS = {
  active: ["paused", "stopping", "asleep", "deregistered"],
  paused: ["active", "stopping", "deregistered"],
  stopping: ["stopped", "deregistered"],
  stopped: ["deregistered"],
  asleep: ["deregistered"],
  deregistered: [],
};

export class GraphStore {
  dataRoot: string;
  /** @param dataRoot 数据根（.dsh/taskmaster/） */
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
  }

  graphDir(graphId) {
    return join(this.dataRoot, "graphs", graphId);
  }

  metaPath(graphId) {
    return join(this.graphDir(graphId), "meta.json");
  }

  eventLog(graphId) {
    return EventLog.open(join(this.dataRoot, "events", `${graphId}.events.ndjson`));
  }

  /**
   * 注册新图或改图（唯一写入口，IF-1）。
   * @param graphId 省略 = 新建（自动生成 id）；给出 = 改图（不存在则 graph-not-found）
   * @param graph 图对象（先经 assertValidGraph）
   * @returns {{ graphId, version }}
   */
  upsert(graph: Graph, { graphId, ownerSessionId }: { graphId?: string; ownerSessionId?: string | null } = {}): { graphId: string; version: number } {
    assertValidGraph(graph);
    const isCreate = graphId === undefined;
    // 新建：生成唯一 id（时间戳 + 随机后缀；同毫秒批量创建也不撞）
    let gid: string | undefined = graphId;
    if (isCreate) {
      for (let attempt = 0; attempt < 3; attempt++) {
        gid = `g-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
        if (!existsSync(this.metaPath(gid))) break;
        gid = undefined;
      }
      if (gid === undefined) {
        const e: any = new Error("graph id allocation conflict after 3 attempts");
        e.code = "write-conflict";
        throw e;
      }
    }
    const finalGid: string = gid as string;
    const metaPath = this.metaPath(finalGid);
    const current = readProjection(metaPath);
    if (!isCreate && current.data === null) throw new GraphNotFoundError(gid);

    const nextVersion = (current.data?.activeVersion ?? 0) + 1;
    // ① 先落版本快照（事实源）
    atomicWriteFileSync(join(this.graphDir(gid), `v${nextVersion}.yaml`), yaml.dump(graph));
    // ② 再翻 meta（CAS：读到的版本不等于期望 = 并发改图，整张图回滚语义由调用方重试）
    const meta = {
      graphId: gid,
      activeVersion: nextVersion,
      lifecycle: current.data?.lifecycle ?? "active",
      ownerSessionId: current.data?.ownerSessionId ?? ownerSessionId ?? null, // 属主窗口（NFR-4：计划卡/上报/人裁的落点）
      updatedAt: new Date().toISOString(),
    };
    casWriteProjection(metaPath, current.version, meta);
    // ③ 事件留痕
    this.eventLog(finalGid).append("register", { graphId: finalGid, version: nextVersion, tasks: graph.tasks.length });
    return { graphId: finalGid, version: nextVersion };
  }

  /** 读图：version 缺省 = 活跃版本；不存在抛 graph-not-found */
  get(graphId: string, version?: number): Graph {
    const meta = this.meta(graphId);
    const v = version ?? meta.activeVersion;
    const p = join(this.graphDir(graphId), `v${v}.yaml`);
    if (!existsSync(p)) throw new GraphNotFoundError(`${graphId}@v${v}`);
    return yaml.load(readFileSync(p, "utf8")) as Graph;
  }

  /** 读图元数据（活跃版本 + 生命周期态） */
  meta(graphId: string): GraphMeta {
    const { data } = readProjection(this.metaPath(graphId));
    if (data === null) throw new GraphNotFoundError(graphId);
    return data;
  }

  /** 列出版本号（只增不删 = 全量可回读） */
  listVersions(graphId: string): number[] {
    const dir = this.graphDir(graphId);
    if (!existsSync(dir)) throw new GraphNotFoundError(graphId);
    return readdirSync(dir)
      .filter((f) => /^v\d+\.yaml$/.test(f))
      .map((f) => Number(f.slice(1, -5)))
      .sort((a, b) => a - b);
  }

  /** 列出全部已注册图 id */
  list(): string[] {
    const dir = join(this.dataRoot, "graphs");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  }

  /**
   * 生命周期迁移（唯一写口）。非法迁移抛 bad-transition。
   * 引擎内部迁移（active→asleep、stopping→stopped）与人裁操作（#10）都走这里。
   * @param actor 操作者（人裁留痕；引擎内部迁移写 "engine"）
   */
  setLifecycle(graphId, next, { actor = "engine" } = {}) {
    const metaPath = this.metaPath(graphId);
    const current = readProjection(metaPath);
    if (current.data === null) throw new GraphNotFoundError(graphId);
    const from = current.data.lifecycle;
    if (!LIFECYCLE_TRANSITIONS[from]?.includes(next)) throw new BadTransitionError(graphId, from, next);
    casWriteProjection(metaPath, current.version, {
      ...current.data,
      lifecycle: next,
      updatedAt: new Date().toISOString(),
    });
    this.eventLog(graphId).append(`graph-${next}`, { graphId, from, actor });
    return { from, to: next };
  }
}
