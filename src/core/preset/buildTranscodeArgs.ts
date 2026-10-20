/**
 * 转码命令生成：把「预设 × 源素材」翻译成一条完整 ffmpeg 参数（含 -i 与收尾五件套）。
 * 铁律（所见即所转）：预设里没写的绝不偷偷加——不改帧率、不升采样、不私换编码器；
 * 分支规则全部在 buildTranscodeArgs.test.ts 锁死，队列引擎是唯一调用方。
 *
 * 收尾固定 ["-y","-progress","pipe:1","-nostats", outPath]（照搬 jian buildExportArgs）：
 * -progress pipe:1 供 Rust 侧逐行读 out_time_us 按 jobId 报进度；-y 免交互卡死。
 *
 * 码率封顶取 maxrate=b:v、bufsize=2×b:v（受限平均码率的通行配法，YouTube 上传建议同款），
 * crf 模式无码率参数。pcm_s16le 是无损编码，不给 -b:a（码率由采样率×位深决定）。
 */
import type { MediaInfo, Preset } from "./types";

/** 翻译结果：图片素材（MVP 边界）与形状非法的预设明确拒绝，让队列引擎标 failed 而非硬编。 */
export type TranscodeArgsResult =
  | { ok: true; args: string[] }
  | { ok: false; error: string };

export function buildTranscodeArgs(preset: Preset, media: MediaInfo, outPath: string): TranscodeArgsResult {
  if (media.kind === "image") {
    return { ok: false, error: `图片素材不在 MVP 转码范围：${media.path}` };
  }
  // 形状自检：视频设置只能进 mp4 容器（mp3/wav 复用器收不了视频轨，跑到 ffmpeg 才炸不如早拒绝）
  if (preset.video && preset.container !== "mp4") {
    return { ok: false, error: `预设形状非法：容器 ${preset.container} 不支持视频轨` };
  }
  // 音视频全空的预设产不出任何流，ffmpeg 只会报 "does not contain any stream"
  if (!preset.video && !preset.audio) {
    return { ok: false, error: "预设形状非法：音视频输出均为空" };
  }

  const args: string[] = ["-i", media.path];

  // ---- 视频段 ----
  if (preset.video) {
    if (media.kind === "video") {
      const v = preset.video;
      args.push("-c:v", v.codec);
      if (v.rate.mode === "bitrate") {
        const kbps = `${v.rate.bitrateKbps}k`;
        args.push("-b:v", kbps, "-maxrate", kbps, "-bufsize", `${v.rate.bitrateKbps * 2}k`);
      } else {
        args.push("-crf", String(v.rate.crf));
      }
      // 仅降采样：源高不超目标高不动它；-2 保宽度为偶数（x264/x265 要偶数尺寸）
      if (v.maxHeight !== "source" && media.height != null && media.height > 0 && media.height > v.maxHeight) {
        args.push("-vf", `scale=-2:${v.maxHeight}`);
      }
      if (v.fps != null) args.push("-r", String(v.fps));
    }
    // 源是纯音频：视频段整个跳过（无流可编，mp4 产物只含音轨），不加任何视频参数
  } else if (media.kind === "video") {
    // 纯音频预设遇视频源：剥视频
    args.push("-vn");
  }

  // ---- 音频段 ----
  if (preset.audio && media.hasAudio) {
    const a = preset.audio;
    args.push("-c:a", a.codec);
    if (a.codec !== "pcm_s16le") args.push("-b:a", `${a.bitrateKbps}k`);
    args.push("-ar", String(a.sampleRate));
  } else if (!preset.audio && media.hasAudio) {
    // 预设不含音频而源有：明确禁声，别让 ffmpeg 自作主张挑默认编码器
    args.push("-an");
  }

  args.push("-y", "-progress", "pipe:1", "-nostats", outPath);
  return { ok: true, args };
}
