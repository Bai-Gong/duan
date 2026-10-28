/**
 * 队列执行引擎：单 worker 串行循环（决策3）。
 *
 * 职责边界：
 * - 全应用唯一 listen("transcode-progress") 方（对接面约定）：事件按 jobId 路由，
 *   ≥100ms 节流合并写 store——ffmpeg -progress 每 tick 多行，直写会打爆 React 渲染；
 * - 取消与失败的可靠区分：调 cancel_transcode 前先在 cancelFlags 打标记，
 *   run_transcode reject 时先查标记——kill 后的非零退出与真失败同走 Err 分支
 *   （jian/ffmpeg.rs:197-205 语义），不查标记则用户取消会误落 failed 并显示 stderr；
 * - 过期/乱序事件双重防御：事件入口按「该 jobId 项仍 running」过滤，
 *   节流 flush 落库前再查一次（缓冲窗口内可能已取消/完成）；
 * - presetId→Preset 解析由接线层注入（resolvePreset）：内置+自建全集的构成
 *   属预设域知识，队列引擎不反向依赖预设 store 的内部 API；
 * - override 合并＝段级浅覆盖（{...preset, ...override}），与 PresetOverride 语义一致。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { buildTranscodeArgs } from "../preset/buildTranscodeArgs";
import { buildYeTranscodeParams } from "../preset/buildYeTranscodeParams";
import type { Preset } from "../preset/types";
import { useQueueStore } from "./store";
import type { QueueItem } from "./types";

/** Rust 侧 TranscodeProgress 事件负载（src-tauri/src/ffmpeg.rs，serde camelCase，开发计划模块2）。 */
export interface TranscodeProgressEvent {
  jobId: string;
  timeUs: number;
  totalUs: number;
}

/** 进度写 store 的最小间隔（ms）；窗口内的多次事件合并为最后一次。 */
export const PROGRESS_THROTTLE_MS = 100;

/** 转码引擎二选一（M3 接线轨）：ffmpeg＝子进程，ye＝进程内（H.264+音频直通）。 */
export type TranscodeEngine = "ffmpeg" | "ye";

export interface StartQueueOptions {
  /** presetId→Preset 解析（内置+自建全集查找）；由接线层（TopBar/导入编排）注入。 */
  resolvePreset(id: string): Preset | undefined;
  /** 当前引擎选择（接线层注入，避免队列引擎反向依赖预设 store）；缺省 ffmpeg。 */
  getEngine?(): TranscodeEngine;
}

// —— runner 会话态（模块级单例：单 worker，同一时刻至多一个循环） ——
/** 循环活性：true 时再调 startQueue 直接返回（防重入）。 */
let loopActive = false;
/** stopQueue 置位：当前项了结后循环不再取下一项（剩余 waiting 原地保留，可再启动）。 */
let stopRequested = false;
/** 取消标记：invoke cancel 前先加，reject 时先查——命中即「用户取消」。 */
const cancelFlags = new Set<string>();
/** 当前 running 项走的引擎：cancelJob 据此路由到对应取消命令（两引擎句柄表独立）。 */
let activeEngine: TranscodeEngine | null = null;
// —— 进度节流缓冲（单 worker，同一时刻至多一个合法 jobId 的事件流） ——
let lastFlushAt = 0;
let buffered: { jobId: string; timeUs: number } | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 仅供测试：复位模块级会话态（清取消标记、停节流定时器）。 */
export function resetRunnerState(): void {
  loopActive = false;
  stopRequested = false;
  cancelFlags.clear();
  activeEngine = null;
  lastFlushAt = 0;
  buffered = null;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

/**
 * 启动队列循环：逐项「取队首 waiting → 生成 args → run_transcode → 落终态」；
 * 无 waiting 项（空队/全终结）或 stopQueue 即停转，循环整体结束后才 resolve。
 * 任何单项的失败/取消都不中断循环，继续下一项。
 */
export async function startQueue(options: StartQueueOptions): Promise<void> {
  if (loopActive) return;
  loopActive = true;
  stopRequested = false;
  useQueueStore.getState().setRunning(true);

  const unlisten = await listen<TranscodeProgressEvent>("transcode-progress", (event) => {
    onProgress(event.payload);
  });
  try {
    while (!stopRequested) {
      const next = useQueueStore.getState().items.find((i) => i.status === "waiting");
      if (!next) break; // 空队停转
      await runOne(next, options);
    }
  } finally {
    loopActive = false;
    stopRequested = false;
    flushBuffered(); // 尾帧进度补写（若缓冲期间项已终态，flush 内部防御会拒写）
    unlisten();
    useQueueStore.getState().setRunning(false);
  }
}

/**
 * 停止队列：当前 running 项走取消链路，剩余 waiting 项原地保留（可再 startQueue）。
 * 「暂停/恢复」是 R1 后置项，MVP 以停止（=取消当前项）代替。
 */
export function stopQueue(): void {
  if (!loopActive) return;
  stopRequested = true;
  const current = useQueueStore
    .getState()
    .items.find((i) => i.status === "running");
  if (current) cancelJob(current.id);
}

/**
 * 取消一个队列项：waiting 直接落 canceled；running 项先打标记再按当前引擎
 * 调对应取消命令（ffmpeg＝kill 子进程；ye＝置 AtomicBool 旗标）。两引擎取消后
 * 的非零结果都走 reject，标记命中才落 canceled 并忽略错误详情。
 * fire-and-forget：不阻塞调用方，结果经 reject 链路回写 store。
 */
export function cancelJob(jobId: string): void {
  const item = useQueueStore.getState().items.find((i) => i.id === jobId);
  if (!item) return;
  if (item.status === "waiting") {
    useQueueStore.getState().cancel(jobId);
    return;
  }
  if (item.status !== "running") return;
  cancelFlags.add(jobId);
  const command = activeEngine === "ye" ? "cancel_transcode_ye" : "cancel_transcode";
  void invoke<null>(command, { jobId }).catch(() => {
    // 取消未送达（转码多半已自行结束）：撤标记，让自然结果说了算，
    // 避免把自然失败误判成「用户取消」。
    cancelFlags.delete(jobId);
  });
}

/** 执行单项。任何出口都落终态（done/failed/canceled），永不抛出——循环不因单项中断。 */
async function runOne(item: QueueItem, options: StartQueueOptions): Promise<void> {
  const store = useQueueStore.getState();
  // markRunning 失败＝取到队首与动手之间该项已被取消/跳过/移除（竞态防御）
  if (!store.markRunning(item.id)) return;

  const current = useQueueStore.getState().items.find((i) => i.id === item.id);
  if (!current) return;

  const engine: TranscodeEngine = options.getEngine?.() ?? "ffmpeg";
  activeEngine = engine;
  try {
    const preset = options.resolvePreset(current.presetId);
    if (!preset) {
      store.setResult(current.id, { status: "failed", error: `预设不存在或已删除：${current.presetId}` });
      return;
    }
    const merged = current.override ? { ...preset, ...current.override } : preset;
    if (engine === "ye") {
      // ye 引擎：preset+源素材 → run_transcode_ye 参数面（能力面外翻译层明确拒绝）。
      // 队列项 mediaInfo（core/media/probe）含尺寸/编码/采样率/声道全集。
      const built = buildYeTranscodeParams(merged, current.mediaInfo);
      if (!built.ok) {
        store.setResult(current.id, { status: "failed", error: built.error });
        return;
      }
      await invoke<null>("run_transcode_ye", {
        jobId: current.id,
        inputPath: current.path,
        outPath: current.outPath,
        width: built.width,
        height: built.height,
        crf: built.crf,
        videoBitrateKbps: built.videoBitrateKbps,
        audioBitrateKbps: built.audioBitrateKbps,
        stripVideo: built.stripVideo,
        stripAudio: built.stripAudio,
        totalUs: Math.max(0, Math.round(current.mediaInfo.durationUs)),
      });
    } else {
      // buildTranscodeArgs 消费 preset/types 的 MediaInfo 子集（含 path、不含 duration 等），
      // 队列项的完整版 mediaInfo（core/media/probe）是它的超集，补上 path 即可
      const built = buildTranscodeArgs(merged, { ...current.mediaInfo, path: current.path }, current.outPath);
      if (!built.ok) {
        // 图片素材（MVP 边界）与形状非法预设：翻译层明确拒绝，落 failed 不硬编
        store.setResult(current.id, { status: "failed", error: built.error });
        return;
      }
      await invoke<null>("run_transcode", {
        jobId: current.id,
        args: built.args,
        outPath: current.outPath,
        totalUs: Math.max(0, Math.round(current.mediaInfo.durationUs)),
      });
    }
    // 转码已自然结束，作废残留标记（用户在完成前一瞬点取消的极端窗口：产物已成，事实优先）
    cancelFlags.delete(current.id);
    store.setResult(current.id, { status: "done" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cancelFlags.delete(current.id)) {
      // 命中取消标记：取消后的非零结果是取消的正常收尾（kill 退出码/Cancelled 皆然），
      // 错误详情是噪音，不落库
      store.setResult(current.id, { status: "canceled" });
    } else {
      store.setResult(current.id, { status: "failed", error: message });
    }
  } finally {
    activeEngine = null;
  }
}

/** 进度事件入口：按项状态防御（取消/完成后仍会收到尾部事件，一律拒收）后进节流缓冲。 */
function onProgress(payload: TranscodeProgressEvent): void {
  const item = useQueueStore.getState().items.find((i) => i.id === payload.jobId);
  if (!item || item.status !== "running") return;
  buffered = { jobId: payload.jobId, timeUs: Math.max(0, payload.timeUs) };
  const since = Date.now() - lastFlushAt;
  if (since >= PROGRESS_THROTTLE_MS) {
    flushBuffered();
  } else if (flushTimer === null) {
    // 只挂一个补写定时器：窗口内后续事件只更新 buffered
    flushTimer = setTimeout(flushBuffered, PROGRESS_THROTTLE_MS - since);
  }
}

/** 落库前再查一次状态：节流窗口内该项可能已被取消/完成。 */
function flushBuffered(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const pending = buffered;
  buffered = null;
  if (!pending) return;
  lastFlushAt = Date.now();
  const item = useQueueStore.getState().items.find((i) => i.id === pending.jobId);
  if (!item || item.status !== "running") return;
  useQueueStore.getState().setProgress(pending.jobId, pending.timeUs);
}
