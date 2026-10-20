/**
 * 队列数据模型（纯数据 + 状态机，无副作用）。
 *
 * 约定（开发计划模块5 / 决策3）：
 * - 单 worker 严格串行：同一时刻至多一项 running；
 * - 状态机 waiting/running/done/failed/canceled/skipped，终态不可再迁移，
 *   合法迁移集中在 QUEUE_TRANSITIONS 一张表，store 一切状态写入按表门禁（非法 no-op）；
 * - waiting→canceled 只允许「未开始就取消」（store.cancel）；running→canceled
 *   只允许 runner 在 run_transcode reject 且命中取消标记时落——kill 后的非零退出
 *   与真失败同走 Err 分支（jian/ffmpeg.rs:197-205 语义），靠标记区分（见 runner.ts）；
 * - 时间单位微秒（progressUs）；队列不持久化，重启即清（决策3）。
 */
import type { MediaInfo } from "../media/probe";
import type { Preset } from "../preset/types";

/** 队列项状态。 */
export type QueueStatus = "waiting" | "running" | "done" | "failed" | "canceled" | "skipped";

/** 终态：不再接受任何迁移（remove 不算迁移，是整项删除）。 */
export const QUEUE_TERMINAL_STATUSES: readonly QueueStatus[] = [
  "done",
  "failed",
  "canceled",
  "skipped",
];

/** 合法迁移表（from → 允许的 to；未列出即非法，写入一律 no-op）。 */
export const QUEUE_TRANSITIONS: Readonly<Record<QueueStatus, readonly QueueStatus[]>> = {
  waiting: ["running", "canceled", "skipped"],
  running: ["done", "failed", "canceled"],
  done: [],
  failed: [],
  canceled: [],
  skipped: [],
};

/** from→to 是否合法迁移。 */
export function canTransition(from: QueueStatus, to: QueueStatus): boolean {
  return QUEUE_TRANSITIONS[from].includes(to);
}

/**
 * 逐项导出设置覆盖（导出设置对话框写入）：段级浅覆盖——
 * video/audio 整段替换（给 null 可表达「关掉该段」），不做字段级深合并。
 * runner 合并方式：{ ...preset, ...override }。
 */
export type PresetOverride = Partial<Preset>;

/** 队列项：一条待转码/已转码任务的全量数据。 */
export interface QueueItem {
  id: string;
  /** 源文件绝对路径。 */
  path: string;
  /** ffprobe 元数据（模块4 core/media/probe 产出，含 durationUs 供进度分母）。 */
  mediaInfo: MediaInfo;
  presetId: string;
  /** 逐项覆盖；runner 浅合并进预设后交 buildTranscodeArgs。 */
  override?: PresetOverride;
  /** 输出绝对路径（入队时按 naming 定稿，含队列内冲突自增）。 */
  outPath: string;
  status: QueueStatus;
  /** 已转码微秒（transcode-progress 事件经 runner ≥100ms 节流回填）。 */
  progressUs: number;
  /** failed 时的错误信息（Rust 回传的 stderr 尾部）。 */
  error?: string;
  /** 入队时间戳（epoch ms）。 */
  addedAt: number;
}
