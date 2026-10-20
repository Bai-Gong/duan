/**
 * 预设类型：内置与自建共用同一形状，builtin 标记区分来源（自建可改可删，内置是常量）。
 * 编码器名一律是有效 ffmpeg 名（libmp3lame / pcm_s16le 等），不造轮子不缩写。
 */

/** 输出容器（MVP 三种）；输出扩展名由容器推导：mp4/mp3/wav。 */
export type Container = "mp4" | "mp3" | "wav";

export type VideoCodec = "libx264" | "libx265";

export type AudioCodec = "aac" | "libmp3lame" | "pcm_s16le";

/**
 * 视频码控二选一：
 * - bitrate：平均码率封顶（-b:v + -maxrate/-bufsize，见 buildTranscodeArgs）；
 * - crf：恒定质量因子（-crf，无码率参数）。
 */
export type VideoRateControl =
  | { mode: "bitrate"; bitrateKbps: number }
  | { mode: "crf"; crf: number };

/** 缩放上限：固定档位或「源高」（永不触发缩放）。 */
export type MaxHeight = 1080 | 720 | "source";

export interface VideoSettings {
  codec: VideoCodec;
  rate: VideoRateControl;
  /** 仅降采样：源高 ≤ 目标高时不加 -vf（见 buildTranscodeArgs）。 */
  maxHeight: MaxHeight;
  /** 输出帧率；null/缺省＝保留源帧率（不产生 -r）。 */
  fps?: number | null;
}

export interface AudioSettings {
  codec: AudioCodec;
  /** 平均码率 kbps；pcm_s16le 是无损编码，忽略此值（不产生 -b:a）。 */
  bitrateKbps: number;
  /** 采样率 Hz（如 44100 / 48000）。 */
  sampleRate: number;
}

export interface Preset {
  /** 内置预设固定 "builtin:xxx"；自建由 store 生成 crypto.randomUUID。 */
  id: string;
  name: string;
  /** 预设浏览器分组用（内置用「视频」「音频」；自建可自定义）。 */
  category: string;
  builtin: boolean;
  container: Container;
  /** null＝纯音频预设（遇视频源加 -vn 剥视频）。 */
  video: VideoSettings | null;
  /** null＝输出无音轨（源有音频时加 -an 明确禁声）；内置预设均含音频。 */
  audio: AudioSettings | null;
}

/**
 * buildTranscodeArgs 消费的源素材信息＝模块2 ProbeResult 的结构子集，另加源路径。
 * 字段口径与 jian/core/media/probe.ts 的 ProbeResult 对齐（kind 三分类、hasAudio、height）；
 * height 收宽为 number | null：jian 先例纯音频回 0，锻允许 0 或 null，翻译层两者等价处理。
 */
export interface MediaInfo {
  /** 源文件绝对路径（-i 入参）。 */
  path: string;
  /** 素材大类；image 在 MVP 边界外，翻译时直接拒绝。 */
  kind: "video" | "audio" | "image";
  /** 源视频高度 px；纯音频/图片为 0 或 null。 */
  height: number | null;
  hasAudio: boolean;
}
