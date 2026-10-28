/**
 * ffprobe 探测门面：Rust 侧 probe_media / ffmpeg_info 命令的 TS 包装。
 *
 * MediaInfo 镜像 src-tauri 的 ProbeResult（serde camelCase）：jian 六字段之外，
 * 锻增 videoCodec/audioCodec/container 供队列表展示（开发计划·模块2 约定）。
 * 口径与 jian/probe.ts 一致：时间一律微秒；图片零时长零帧率；kind 判定次序
 * 在 Rust 纯函数里写死，前端只透传、不改写——两端口径必须一致。
 * 分层纪律「Rust 命令只被 core 调」：invoke 不出 core 层。
 */
import { invoke } from "@tauri-apps/api/core";

/** 媒体种类（与 Rust classify_media_kind 的返回值对齐）。 */
export type MediaKind = "video" | "audio" | "image";

/** 与 src-tauri ProbeResult 对齐（serde camelCase）。无对应流时 codec 为空串；纯音频宽高为 0。 */
export interface MediaInfo {
  /** 总时长（微秒）；图片恒 0。 */
  durationUs: number;
  width: number;
  height: number;
  /** 帧率；纯音频/图片为 0。 */
  fps: number;
  hasAudio: boolean;
  kind: MediaKind;
  /** 第一条内容视频流的 codec_name（如 h264/hevc；内嵌封面不计）；无视频流为空串。 */
  videoCodec: string;
  /** 第一条音频流的 codec_name（如 aac/mp3）；无音轨为空串。 */
  audioCodec: string;
  /** 容器格式名（ffprobe format_name 原样，如 "mov,mp4,m4a,3gp,3g2,mj2"）。 */
  container: string;
  /** 第一条音频流采样率 Hz（M3 补齐：ye 引擎翻译层校验用）；无音轨为 0。 */
  sampleRate: number;
  /** 第一条音频流声道数；无音轨为 0。 */
  channels: number;
}

/** ffmpeg 定位结果（ffmpeg_info 命令）。source ∈ {"env","sidecar","path"}。 */
export interface FfmpegInfo {
  ffmpegPath: string;
  ffprobePath: string;
  source: string;
}

/** 探测单个媒体文件；失败（无法识别/文件损坏）由 Rust 侧返回 Err，此处原样抛出。 */
export function probeMedia(path: string): Promise<MediaInfo> {
  return invoke<MediaInfo>("probe_media", { path });
}

/**
 * 启动自检：定位 ffmpeg/ffprobe（三档：BJ_FFMPEG_DIR → src-tauri/binaries → 系统 PATH）。
 * 失败原样抛出——错误文案由 Rust 带回（含「设 BJ_FFMPEG_DIR 或运行
 * scripts/fetch-ffmpeg.mjs 下载到 src-tauri/binaries/」引导），UI 捕获后直接展示即可，
 * 前端不再另行编文案。
 */
export function ffmpegInfo(): Promise<FfmpegInfo> {
  return invoke<FfmpegInfo>("ffmpeg_info");
}
