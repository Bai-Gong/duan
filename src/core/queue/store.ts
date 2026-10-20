/**
 * 队列状态：items 顺序数组（数组序即队列表展示序与执行优先序）。
 *
 * 写入纪律：
 * - 一切状态迁移过 QUEUE_TRANSITIONS 门禁，非法迁移 no-op（防御 UI 乱序点击与过期事件）；
 * - store 只管状态，不管副作用：run_transcode/cancel_transcode 调用与进度事件监听
 *   全部在 runner.ts（「Rust 命令只被 core 调」，且 runner 是唯一 listen 方）；
 * - cancel 仅接受 waiting（未开始项直接落 canceled）；running 项的取消必须走
 *   runner.cancelJob——先打取消标记再 kill，等 run_transcode reject 才落 canceled，
 *   否则进程还在跑而状态已终，进度/结果语义全乱；
 * - remove 不接受 running 项（先 cancelJob，落 canceled 后再移除）；
 * - 队列不持久化（决策3），重启即清；预设/收藏/默认输出目录的持久化在预设 store。
 */
import type { MediaInfo } from "../media/probe";
import { create } from "zustand";
import { resolveOutputPath } from "./naming";
import { canTransition, type PresetOverride, type QueueItem } from "./types";

/**
 * 入队输入：path/mediaInfo 之外，命名所需信息（预设名/输出目录/扩展名）
 * 由调用方（导入编排层）解析携带——队列不反向依赖预设 store，避免耦合其 API。
 */
export interface AddQueueEntry {
  path: string;
  mediaInfo: MediaInfo;
  presetId: string;
  /** 预设显示名（输出命名 {name}.{presetLabel}.{ext}）。 */
  presetLabel: string;
  /** 输出目录（默认输出目录，预设 store 持久化）。 */
  outDir: string;
  /** 输出扩展名（预设容器推导：mp4/mp3/wav），可带前置点。 */
  ext: string;
  /** 逐项导出设置覆盖。 */
  override?: PresetOverride;
}

/** 终态写入参数：error 仅 failed 时落库，其余终态清空残留。 */
export interface QueueSettlement {
  status: "done" | "failed" | "canceled";
  error?: string;
}

/** 队列汇总（TopBar 队列控制与「正在编码」面板消费）。 */
export interface QueueSummary {
  total: number;
  waiting: number;
  running: number;
  done: number;
  failed: number;
  canceled: number;
  skipped: number;
  /** 已落终态的项数（done+failed+canceled+skipped），完成提示/剩余估算用。 */
  finished: number;
}

export interface QueueState {
  items: QueueItem[];
  /** 队列会话态：startQueue 置 true、停转/停止后 false；UI 只读。 */
  running: boolean;
  /** 批量入队：生成 id/outPath（队列内冲突自增）/初始状态；返回新项 id（与入参同序）。 */
  add(entries: AddQueueEntry[]): string[];
  /** 移除队列项；running 项拒绝（先取消，落终态后再移除）。 */
  remove(id: string): void;
  /** 与前一项交换位置；队首或 running 项 no-op。 */
  moveUp(id: string): void;
  /** 与后一项交换位置；队尾或 running 项 no-op。 */
  moveDown(id: string): void;
  /** 仅 waiting→skipped（skip 只对未开始项）。 */
  skip(id: string): void;
  /** 仅 waiting→canceled（未开始项直接取消）；running 项走 runner.cancelJob。 */
  cancel(id: string): void;
  /** waiting→running（runner 取队首成功后调用）；迁移非法（已被取消/跳过/移除）返回 false。 */
  markRunning(id: string): boolean;
  /** 进度回填（仅 running 项生效，乱序/过期事件被拒）；progressUs 钳 ≥0。 */
  setProgress(id: string, progressUs: number): void;
  /** 落终态 done/failed/canceled（仅 running 项、按迁移表门禁）。 */
  setResult(id: string, settlement: QueueSettlement): void;
  /** 队列会话态写入（runner 专用）。 */
  setRunning(running: boolean): void;
}

/** 不可变更新指定项（不存在则原样返回）。 */
function patchItem(items: QueueItem[], id: string, patch: Partial<QueueItem>): QueueItem[] {
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return items;
  const next = items.slice();
  next[idx] = { ...next[idx], ...patch };
  return next;
}

export const useQueueStore = create<QueueState>()((set, get) => ({
  items: [],
  running: false,

  add: (entries) => {
    if (entries.length === 0) return [];
    const items = get().items;
    // 冲突集合＝队列已有 outPath ＋ 本批刚生成的（同批同名也逐个让位）
    const taken = new Set(items.map((i) => i.outPath));
    const addedAt = Date.now();
    const newItems: QueueItem[] = entries.map((e) => {
      const id = crypto.randomUUID();
      const outPath = resolveOutputPath(e.outDir, e.path, e.presetLabel, e.ext, taken);
      taken.add(outPath);
      return {
        id,
        path: e.path,
        mediaInfo: e.mediaInfo,
        presetId: e.presetId,
        override: e.override,
        outPath,
        status: "waiting",
        progressUs: 0,
        addedAt,
      };
    });
    set({ items: [...items, ...newItems] });
    return newItems.map((i) => i.id);
  },

  remove: (id) => {
    const target = get().items.find((i) => i.id === id);
    if (!target || target.status === "running") return; // running 项不可直接移除
    set({ items: get().items.filter((i) => i.id !== id) });
  },

  moveUp: (id) => {
    const items = get().items;
    const idx = items.findIndex((i) => i.id === id);
    if (idx <= 0 || items[idx].status === "running") return;
    const next = items.slice();
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    set({ items: next });
  },

  moveDown: (id) => {
    const items = get().items;
    const idx = items.findIndex((i) => i.id === id);
    if (idx < 0 || idx >= items.length - 1 || items[idx].status === "running") return;
    const next = items.slice();
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    set({ items: next });
  },

  skip: (id) => {
    const target = get().items.find((i) => i.id === id);
    if (!target || !canTransition(target.status, "skipped")) return;
    set({ items: patchItem(get().items, id, { status: "skipped" }) });
  },

  cancel: (id) => {
    const target = get().items.find((i) => i.id === id);
    // 只认 waiting：running 项的取消是「标记→kill→等 reject」链路，归 runner.cancelJob
    if (!target || target.status !== "waiting") return;
    set({ items: patchItem(get().items, id, { status: "canceled" }) });
  },

  markRunning: (id) => {
    const target = get().items.find((i) => i.id === id);
    if (!target || !canTransition(target.status, "running")) return false;
    set({ items: patchItem(get().items, id, { status: "running", progressUs: 0 }) });
    return true;
  },

  setProgress: (id, progressUs) => {
    const target = get().items.find((i) => i.id === id);
    if (!target || target.status !== "running") return;
    set({ items: patchItem(get().items, id, { progressUs: Math.max(0, progressUs) }) });
  },

  setResult: (id, settlement) => {
    const target = get().items.find((i) => i.id === id);
    if (!target || !canTransition(target.status, settlement.status)) return;
    set({
      items: patchItem(get().items, id, {
        status: settlement.status,
        // error 只在 failed 落库；其余终态显式清空（覆盖旧值）
        error: settlement.status === "failed" ? settlement.error : undefined,
      }),
    });
  },

  setRunning: (running) => set({ running }),
}));

/** 汇总：按状态计数。 */
export function selectQueueSummary(s: QueueState): QueueSummary {
  const summary: QueueSummary = {
    total: s.items.length,
    waiting: 0,
    running: 0,
    done: 0,
    failed: 0,
    canceled: 0,
    skipped: 0,
    finished: 0,
  };
  for (const item of s.items) summary[item.status] += 1;
  summary.finished = summary.done + summary.failed + summary.canceled + summary.skipped;
  return summary;
}

/** 当前 running 项（单 worker 至多一个；「正在编码」面板消费）。 */
export function selectRunningItem(s: QueueState): QueueItem | undefined {
  return s.items.find((i) => i.status === "running");
}
