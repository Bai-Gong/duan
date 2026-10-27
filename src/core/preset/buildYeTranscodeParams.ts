/**
 * ye 引擎的预设→参数翻译（纯函数）：与 buildTranscodeArgs 同一「锁住所见即所转」
 * 的思路，但目标不是 ffmpeg argv 而是 Rust 命令 run_transcode_ye 的入参
 * （目标尺寸 + CRF）。能力面之外的一律明确拒绝并给可操作的错误文案
 * （不静默降级——静默忽略预设项会让用户以为生效了）。
 *
 * ye M3 首轮能力面：输入 H.264 的 MP4，视频重编码 H.264 Baseline（CRF），
 * 音频包直通（预设的音频编码器/码率/采样率不重编码、原样直通），输出 MP4。
 * 不支持面与拒绝文案：
 * - 非 MP4 容器 / 纯音频预设（video=null）——ye 只会输出「视频重编码 + 音频直通」的 MP4；
 * - libx265——ye 编码器目前只有 H.264；
 * - 目标码率模式——ye 真码控（CBR/A-VBR/2-pass）后续批次交付；
 * - 改帧率——convert 链目前只有缩放/像素格式，fps 参数后续接入；
 * - 非 H.264 源——ye 解码面目前只有 H.264（HEVC 解码 M5）；
 * - video=null 或 audio=null 的剥轨语义——直通引擎不做增删轨。
 */

/** 源素材信息＝队列项 mediaInfo（core/media/probe 的完整版）的结构子集。 */
export interface YeMediaSource {
  /** 素材大类；ye 引擎只接视频。 */
  kind: "video" | "audio" | "image";
  /** 源视频宽高 px（even；计算缩放目标用）。 */
  width: number;
  height: number;
  /** 第一条视频流的 codec_name（如 h264/hevc）。 */
  videoCodec: string;
}

/** 翻译结果：成功＝run_transcode_ye 的参数面；失败＝可直接展示的错误。 */
export type YeTranscodeBuilt =
  | { ok: true; width: number | null; height: number | null; crf: number }
  | { ok: false; error: string };

/** 宽度按目标高度等比缩放并取偶（H.264 4:2:0 要求；round-half-up 再修正奇数）。 */
function evenWidthFor(srcW: number, srcH: number, targetH: number): number {
  const w = Math.round((srcW * targetH) / srcH);
  return w % 2 === 0 ? w : w + 1;
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
  const video = preset.video;
  if (!video) {
    return { ok: false, error: "纯音频预设需要 AAC 重编码（ye 后续批次交付），请切回 ffmpeg 引擎" };
  }
  if (!preset.audio) {
    return { ok: false, error: "ye 引擎音频包直通、不做剥轨（输出无音轨的预设请用 ffmpeg 引擎）" };
  }
  if (video.codec !== "libx264") {
    return { ok: false, error: `ye 引擎目前只编码 H.264（${video.codec} 后续支持），请切回 ffmpeg 引擎` };
  }
  if (video.rate.mode !== "crf") {
    return { ok: false, error: "ye 引擎暂不支持目标码率（真码控后续批次），请把预设切成 CRF 模式或用 ffmpeg 引擎" };
  }
  if (video.fps != null) {
    return { ok: false, error: "ye 引擎暂不支持改帧率（fps 滤镜参数后续接入），请清除预设帧率或用 ffmpeg 引擎" };
  }
  if (media.kind !== "video") {
    return { ok: false, error: "ye 引擎只接视频素材（音频/图片请用 ffmpeg 引擎）" };
  }
  const codec = media.videoCodec.toLowerCase();
  if (codec !== "h264" && codec !== "avc1") {
    return { ok: false, error: `ye 引擎目前只解码 H.264 源（检测到 ${media.videoCodec || "未知"}；HEVC 解码 M5 交付），请切回 ffmpeg 引擎` };
  }
  if (typeof video.maxHeight === "number" && media.height > video.maxHeight) {
    if (!(media.width > 0) || !(media.height > 0)) {
      return { ok: false, error: "源宽高缺失，无法计算缩放目标" };
    }
    return {
      ok: true,
      width: evenWidthFor(media.width, media.height, video.maxHeight),
      height: video.maxHeight,
      crf: video.rate.crf,
    };
  }
  return { ok: true, width: null, height: null, crf: video.rate.crf };
}
