/**
 * ye 引擎的预设→参数翻译（纯函数）：与 buildTranscodeArgs 同一「锁住所见即所转」
 * 的思路，但目标不是 ffmpeg argv 而是 Rust 命令 run_transcode_ye 的入参
 * （尺寸/CRF 基准/视频码率/音频码率/剥轨旗标）。能力面之外的一律明确拒绝
 * 并给可操作的错误文案（不静默降级——静默忽略预设项会让用户以为生效了）。
 *
 * ye M3 补齐后的能力面：输入 MP4 系容器，视频重编码 H.264 Baseline
 * （CRF 质量模式，或目标码率的 A-VBR 封顶——真码控），音频 AAC-LC
 * 重编码（按预设码率）或直通；支持剥视频（纯音频输出）/剥音轨。
 * 仍不支持面与拒绝文案：
 * - 非 MP4 系容器（输入或输出）——ye 只解封装/封装 MP4；
 * - libx265——ye 编码器目前只有 H.264；
 * - 改帧率——convert 链目前只有缩放/像素格式，fps 参数后续接入；
 * - 非 H.264 视频源（需要重编码视频轨时）——ye 解码面目前只有 H.264（HEVC M5）；
 * - 非 AAC 的音频编码器（libmp3lame/pcm_s16le）——ye 音频编码面只有 AAC-LC；
 * - 非 AAC 音频源（需要重编码音频轨时）——ye 音频解码面只有 AAC；
 * - 改采样率——无重采样器，预设采样率须与源一致；
 * - 多声道（>2）重编码——AAC-LC 编码面单/双声道（CPE/SCE）；
 * - 视频预设遇音频素材 / 音频预设遇无音轨源——无从产出。
 */

/** 源素材信息＝队列项 mediaInfo（core/media/probe 的完整版）的结构子集。 */
export interface YeMediaSource {
  /** 素材大类；音频素材只接纯音频预设。 */
  kind: "video" | "audio" | "image";
  /** 源视频宽高 px（even；计算缩放目标用；纯音频为 0）。 */
  width: number;
  height: number;
  /** 第一条内容视频流的 codec_name（如 h264/hevc；无视频流为空串）。 */
  videoCodec: string;
  /** 第一条音频流的 codec_name（如 aac/mp3；无音轨为空串）。 */
  audioCodec: string;
  /** 有无音轨。 */
  hasAudio: boolean;
  /** 第一条音频流采样率 Hz（无音轨为 0）。 */
  sampleRate: number;
  /** 第一条音频流声道数（无音轨为 0）。 */
  channels: number;
  /** 容器展示名（如 "mp4"/"m4a"/"matroska"；见 probe 的 container_display）。 */
  container: string;
}

/** 翻译结果：成功＝run_transcode_ye 的参数面；失败＝可直接展示的错误。 */
export type YeTranscodeBuilt =
  | {
      ok: true;
      /** 目标宽（null = 保持原尺寸）。 */
      width: number | null;
      height: number | null;
      /** 基准 CRF（1..=51）：纯质量模式即预设 CRF；码率模式固定 23 作 A-VBR 基准。 */
      crf: number;
      /** 视频目标码率 kbps（null = 纯质量模式）。 */
      videoBitrateKbps: number | null;
      /** 音频重编码码率 kbps（null = 直通）。 */
      audioBitrateKbps: number | null;
      /** 剥视频（纯音频输出）。 */
      stripVideo: boolean;
      /** 剥音轨（输出无音轨）。 */
      stripAudio: boolean;
    }
  | { ok: false; error: string };

/** MP4 系容器的展示名集合（probe 的 container_display 取的是 format_name 段）。 */
const MP4_FAMILY = new Set(["mp4", "mov", "m4a", "3gp", "3g2", "mj2"]);

/** 容器是否 MP4 系（ye 解封装/封装面）。 */
function isMp4Family(container: string): boolean {
  return MP4_FAMILY.has(container.trim().toLowerCase());
}

/** 宽度按目标高度等比缩放并取偶（H.264 4:2:0 要求；round-half-up 再修正奇数）。 */
function evenWidthFor(srcW: number, srcH: number, targetH: number): number {
  const w = Math.round((srcW * targetH) / srcH);
  return w % 2 === 0 ? w : w + 1;
}

type Reject = { ok: false; error: string };

/**
 * 音频重编码前置校验（AAC 编码器 + AAC 解码面的能力面）：
 * 源须有 AAC 音轨、预设采样率须与源一致（无重采样器）、声道 ≤ 2。
 */
function checkAudioReencode(
  audio: import("./types").AudioSettings,
  media: YeMediaSource,
): Reject | { ok: true } {
  if (!media.hasAudio) {
    return {
      ok: false,
      error: "源素材无音轨，音频重编码无从产出（剥音轨预设可用，或切回 ffmpeg 引擎）",
    };
  }
  const src = media.audioCodec.toLowerCase();
  if (src !== "aac") {
    return {
      ok: false,
      error: `ye 引擎目前只解码 AAC 音频源（检测到 ${media.audioCodec || "未知"}），请切回 ffmpeg 引擎`,
    };
  }
  if (media.sampleRate === 0) {
    return { ok: false, error: "源采样率未知，无法校验音频重编码参数（请切回 ffmpeg 引擎）" };
  }
  if (audio.sampleRate !== media.sampleRate) {
    return {
      ok: false,
      error: `ye 引擎暂不支持改采样率（预设 ${audio.sampleRate}Hz ≠ 源 ${media.sampleRate}Hz，无重采样器），请对齐预设或用 ffmpeg 引擎`,
    };
  }
  if (media.channels !== 1 && media.channels !== 2) {
    return {
      ok: false,
      error: `ye 引擎目前重编码单/双声道（检测到 ${media.channels} 声道），请切回 ffmpeg 引擎`,
    };
  }
  return { ok: true };
}

/**
 * 把预设+源素材翻译成 ye 引擎参数。缩放语义与 buildTranscodeArgs 的 -vf scale
 * 一致：仅降采样（maxHeight 为数字且源高更高时才缩，"source"/源高更小保持原样）。
 */
export function buildYeTranscodeParams(
  preset: import("./types").Preset,
  media: YeMediaSource,
): YeTranscodeBuilt {
  if (preset.container !== "mp4") {
    return { ok: false, error: `ye 引擎目前只输出 MP4（预设容器：${preset.container}），请切回 ffmpeg 引擎` };
  }
  if (!isMp4Family(media.container)) {
    return {
      ok: false,
      error: `ye 引擎只解封装 MP4 系容器（检测到 ${media.container || "未知"}），请切回 ffmpeg 引擎`,
    };
  }
  if (media.kind === "image") {
    return { ok: false, error: "ye 引擎不接图片素材（请用 ffmpeg 引擎）" };
  }
  const video = preset.video;
  if (!video) {
    return buildAudioOnly(preset, media);
  }
  return buildWithVideo(preset, media, video);
}

/** 纯音频预设（video=null）：剥视频 + AAC 重编码。 */
function buildAudioOnly(
  preset: import("./types").Preset,
  media: YeMediaSource,
): YeTranscodeBuilt {
  const audio = preset.audio;
  if (!audio) {
    return {
      ok: false,
      error: "纯音频预设无音频设置（剥视频+剥音轨＝空输出），请用 ffmpeg 引擎",
    };
  }
  if (audio.codec !== "aac") {
    return {
      ok: false,
      error: `ye 引擎音频只支持 AAC-LC 重编码（${audio.codec} 后续支持），请切回 ffmpeg 引擎`,
    };
  }
  const check = checkAudioReencode(audio, media);
  if (!check.ok) return check;
  return {
    ok: true,
    width: null,
    height: null,
    crf: 23, // 无视频轨，基准值不参与编码
    videoBitrateKbps: null,
    audioBitrateKbps: audio.bitrateKbps,
    stripVideo: true,
    stripAudio: false,
  };
}

/** 视频预设：视频重编码（CRF/A-VBR）+ 音频三态（直通/AAC 重编码/剥轨）。 */
function buildWithVideo(
  preset: import("./types").Preset,
  media: YeMediaSource,
  video: import("./types").VideoSettings,
): YeTranscodeBuilt {
  if (video.codec !== "libx264") {
    return { ok: false, error: `ye 引擎目前只编码 H.264（${video.codec} 后续支持），请切回 ffmpeg 引擎` };
  }
  if (video.fps != null) {
    return { ok: false, error: "ye 引擎暂不支持改帧率（fps 滤镜参数后续接入），请清除预设帧率或用 ffmpeg 引擎" };
  }
  if (media.kind !== "video") {
    return { ok: false, error: "ye 引擎的视频预设只接视频素材（音频素材请用纯音频预设或 ffmpeg 引擎）" };
  }
  const codec = media.videoCodec.toLowerCase();
  if (codec !== "h264" && codec !== "avc1") {
    return { ok: false, error: `ye 引擎目前只解码 H.264 源（检测到 ${media.videoCodec || "未知"}；HEVC 解码 M5 交付），请切回 ffmpeg 引擎` };
  }

  // 音频三态：null＝剥轨；aac＝重编码（校验能力面）；其他编码器＝拒绝。
  let audioBitrateKbps: number | null = null;
  let stripAudio = false;
  const audio = preset.audio;
  if (!audio) {
    stripAudio = true;
  } else if (audio.codec !== "aac") {
    return {
      ok: false,
      error: `ye 引擎音频只支持 AAC-LC 重编码或直通（${audio.codec} 后续支持），请切回 ffmpeg 引擎`,
    };
  } else {
    const check = checkAudioReencode(audio, media);
    if (!check.ok) return check;
    audioBitrateKbps = audio.bitrateKbps;
  }

  // 码控二态：crf＝纯质量；bitrate＝A-VBR（真码控，CRF 23 基准 + 码率封顶）。
  let crf: number;
  let videoBitrateKbps: number | null = null;
  if (video.rate.mode === "bitrate") {
    videoBitrateKbps = video.rate.bitrateKbps;
    crf = 23;
  } else {
    crf = video.rate.crf;
  }

  if (typeof video.maxHeight === "number" && media.height > video.maxHeight) {
    if (!(media.width > 0) || !(media.height > 0)) {
      return { ok: false, error: "源宽高缺失，无法计算缩放目标" };
    }
    return {
      ok: true,
      width: evenWidthFor(media.width, media.height, video.maxHeight),
      height: video.maxHeight,
      crf,
      videoBitrateKbps,
      audioBitrateKbps,
      stripVideo: false,
      stripAudio,
    };
  }
  return {
    ok: true,
    width: null,
    height: null,
    crf,
    videoBitrateKbps,
    audioBitrateKbps,
    stripVideo: false,
    stripAudio,
  };
}
