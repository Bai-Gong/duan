/**
 * 内置预设（MVP 七个）：视频四档 + 音频三档。
 * - H.264 走平均码率封顶（高/中 1080p + 720p 三档），H.265 走 crf 恒定质量——
 *   两种码控模式在内置集里都有代表，自建预设沿用同一形状；
 * - 音频三档覆盖三种容器：MP3（libmp3lame）、AAC（mp4 容器纯音频）、WAV（pcm_s16le 无损）；
 * - 视频档 fps 一律保留源帧率（fps: null），内置不偷偷改帧率。
 */
import type { Preset } from "./types";

export const BUILTIN_PRESETS: readonly Preset[] = [
  {
    id: "builtin:h264-1080p-high",
    name: "H.264 1080p 高码率",
    category: "视频",
    builtin: true,
    container: "mp4",
    video: {
      codec: "libx264",
      rate: { mode: "bitrate", bitrateKbps: 12_000 },
      maxHeight: 1080,
      fps: null,
    },
    audio: { codec: "aac", bitrateKbps: 256, sampleRate: 48_000 },
  },
  {
    id: "builtin:h264-1080p-mid",
    name: "H.264 1080p",
    category: "视频",
    builtin: true,
    container: "mp4",
    video: {
      codec: "libx264",
      rate: { mode: "bitrate", bitrateKbps: 8_000 },
      maxHeight: 1080,
      fps: null,
    },
    audio: { codec: "aac", bitrateKbps: 192, sampleRate: 48_000 },
  },
  {
    id: "builtin:h264-720p",
    name: "H.264 720p",
    category: "视频",
    builtin: true,
    container: "mp4",
    video: {
      codec: "libx264",
      rate: { mode: "bitrate", bitrateKbps: 5_000 },
      maxHeight: 720,
      fps: null,
    },
    audio: { codec: "aac", bitrateKbps: 128, sampleRate: 48_000 },
  },
  {
    id: "builtin:h265-1080p",
    name: "H.265 1080p",
    category: "视频",
    builtin: true,
    container: "mp4",
    video: {
      codec: "libx265",
      rate: { mode: "crf", crf: 24 },
      maxHeight: 1080,
      fps: null,
    },
    audio: { codec: "aac", bitrateKbps: 192, sampleRate: 48_000 },
  },
  {
    id: "builtin:mp3-320k",
    name: "MP3 320k",
    category: "音频",
    builtin: true,
    container: "mp3",
    video: null,
    audio: { codec: "libmp3lame", bitrateKbps: 320, sampleRate: 44_100 },
  },
  {
    id: "builtin:aac-256k",
    name: "AAC 256k",
    category: "音频",
    builtin: true,
    container: "mp4", // AAC 纯音频走 mp4 容器（即 m4a 内容、.mp4 扩展名）
    video: null,
    audio: { codec: "aac", bitrateKbps: 256, sampleRate: 48_000 },
  },
  {
    id: "builtin:wav-pcm",
    name: "WAV PCM",
    category: "音频",
    builtin: true,
    container: "wav",
    video: null,
    // pcm_s16le 无损：bitrateKbps 无意义，置 0 且翻译层不产生 -b:a
    audio: { codec: "pcm_s16le", bitrateKbps: 0, sampleRate: 48_000 },
  },
];
