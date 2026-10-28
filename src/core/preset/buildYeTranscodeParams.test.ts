/**
 * buildYeTranscodeParams 行为测试：锁住「能力面内如实翻译、能力面外明确拒绝」——
 * 缩放语义与 buildTranscodeArgs 一致（仅降采样、等比取偶），M3 补齐后的
 * 新能力面（目标码率 A-VBR、AAC 重编码、剥视频/剥音轨）逐项锁形，拒绝
 * 文案可操作（指路 ffmpeg 引擎或预设改法），不静默降级。
 */
import { describe, expect, it } from "vitest";
import { buildYeTranscodeParams } from "./buildYeTranscodeParams";
import type { YeMediaSource } from "./buildYeTranscodeParams";
import type { Preset } from "./types";

function makePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: "test:preset",
    name: "测试预设",
    category: "视频",
    builtin: false,
    container: "mp4",
    video: { codec: "libx264", rate: { mode: "crf", crf: 23 }, maxHeight: "source", fps: null },
    audio: { codec: "aac", bitrateKbps: 256, sampleRate: 48000 },
    ...overrides,
  };
}

function makeMedia(overrides: Partial<YeMediaSource> = {}): YeMediaSource {
  return {
    kind: "video",
    width: 1920,
    height: 1080,
    videoCodec: "h264",
    audioCodec: "aac",
    hasAudio: true,
    sampleRate: 48000,
    channels: 2,
    container: "mp4",
    ...overrides,
  };
}

/** 成功态的完整形状（除 width/height/crf/码率外的固定底座）。 */
function okShape(extra: {
  width: number | null;
  height: number | null;
  crf: number;
  videoBitrateKbps: number | null;
  audioBitrateKbps: number | null;
  stripVideo: boolean;
  stripAudio: boolean;
}) {
  return { ok: true as const, ...extra };
}

describe("能力面内翻译（M3 首轮：CRF + 音频重编码基准形状）", () => {
  it("CRF + 源高不超上限：保持原尺寸，crf 透传，音频按预设重编码", () => {
    // 基准形状：预设 aac 256k 48k + 源 aac 48k 立体声 → AAC 重编码 256k
    // （M3 补齐起音频参数如实生效，不再静默直通）。
    const built = buildYeTranscodeParams(makePreset(), makeMedia());
    expect(built).toEqual(
      okShape({
        width: null,
        height: null,
        crf: 23,
        videoBitrateKbps: null,
        audioBitrateKbps: 256,
        stripVideo: false,
        stripAudio: false,
      }),
    );
  });

  it("maxHeight 触发仅降采样：等比取偶宽", () => {
    const p720 = makePreset({
      video: { codec: "libx264", rate: { mode: "crf", crf: 20 }, maxHeight: 720, fps: null },
    });
    // 1920x1080 → 720：宽 1920*720/1080=1280（已偶）
    expect(buildYeTranscodeParams(p720, makeMedia())).toEqual(
      okShape({
        width: 1280,
        height: 720,
        crf: 20,
        videoBitrateKbps: null,
        audioBitrateKbps: 256,
        stripVideo: false,
        stripAudio: false,
      }),
    );
    // 480p 源在 720 上限下不缩放（仅降采样语义）
    expect(buildYeTranscodeParams(p720, makeMedia({ width: 858, height: 480 }))).toEqual(
      okShape({
        width: null,
        height: null,
        crf: 20,
        videoBitrateKbps: null,
        audioBitrateKbps: 256,
        stripVideo: false,
        stripAudio: false,
      }),
    );
    // 奇宽源 858x960 → 720：宽 858*720/960=643.5 → round-half-up 644 再取偶
    expect(buildYeTranscodeParams(p720, makeMedia({ width: 858, height: 960 }))).toEqual(
      okShape({
        width: 644,
        height: 720,
        crf: 20,
        videoBitrateKbps: null,
        audioBitrateKbps: 256,
        stripVideo: false,
        stripAudio: false,
      }),
    );
  });

  it("源高≤目标高不放大（与 ffmpeg 引擎的仅降采样语义一致）", () => {
    const preset = makePreset({
      video: { codec: "libx264", rate: { mode: "crf", crf: 23 }, maxHeight: 1080, fps: null },
    });
    expect(buildYeTranscodeParams(preset, makeMedia({ width: 1280, height: 720 }))).toEqual(
      okShape({
        width: null,
        height: null,
        crf: 23,
        videoBitrateKbps: null,
        audioBitrateKbps: 256,
        stripVideo: false,
        stripAudio: false,
      }),
    );
  });

  it("源编码 avc1（MP4 常见 codec_name 变体）按 H.264 放行", () => {
    expect(buildYeTranscodeParams(makePreset(), makeMedia({ videoCodec: "avc1" })).ok).toBe(true);
  });
});

describe("能力面内翻译（M3 补齐新增）", () => {
  it("目标码率模式：A-VBR——videoBitrateKbps 透传、基准 CRF 固定 23", () => {
    const preset = makePreset({
      video: {
        codec: "libx264",
        rate: { mode: "bitrate", bitrateKbps: 8000 },
        maxHeight: "source",
        fps: null,
      },
    });
    expect(buildYeTranscodeParams(preset, makeMedia())).toEqual(
      okShape({
        width: null,
        height: null,
        crf: 23,
        videoBitrateKbps: 8000,
        audioBitrateKbps: 256,
        stripVideo: false,
        stripAudio: false,
      }),
    );
  });

  it("纯音频预设（mp4 容器 + AAC）：剥视频 + AAC 重编码", () => {
    const preset = makePreset({ video: null });
    // 视频源剥视频
    expect(buildYeTranscodeParams(preset, makeMedia())).toEqual(
      okShape({
        width: null,
        height: null,
        crf: 23,
        videoBitrateKbps: null,
        audioBitrateKbps: 256,
        stripVideo: true,
        stripAudio: false,
      }),
    );
    // 音频源（m4a）同样可转
    expect(
      buildYeTranscodeParams(preset, makeMedia({ kind: "audio", container: "m4a", videoCodec: "" })),
    ).toEqual(
      okShape({
        width: null,
        height: null,
        crf: 23,
        videoBitrateKbps: null,
        audioBitrateKbps: 256,
        stripVideo: true,
        stripAudio: false,
      }),
    );
  });

  it("剥音轨预设（audio=null）：stripAudio", () => {
    const built = buildYeTranscodeParams(makePreset({ audio: null }), makeMedia());
    expect(built).toEqual(
      okShape({
        width: null,
        height: null,
        crf: 23,
        videoBitrateKbps: null,
        audioBitrateKbps: null,
        stripVideo: false,
        stripAudio: true,
      }),
    );
  });

  it("单声道源重编码：channels=1 放行", () => {
    expect(buildYeTranscodeParams(makePreset(), makeMedia({ channels: 1 })).ok).toBe(true);
  });
});

describe("能力面外明确拒绝（不静默降级）", () => {
  it.each<[string, Preset, YeMediaSource, string]>([
    ["非 MP4 输出容器", makePreset({ container: "mp3" }), makeMedia(), "只输出 MP4"],
    ["非 MP4 系输入容器", makePreset(), makeMedia({ container: "matroska" }), "MP4 系容器"],
    [
      "H.265 编码",
      makePreset({
        video: { codec: "libx265", rate: { mode: "crf", crf: 23 }, maxHeight: "source", fps: null },
      }),
      makeMedia(),
      "只编码 H.264",
    ],
    [
      "改帧率",
      makePreset({
        video: { codec: "libx264", rate: { mode: "crf", crf: 23 }, maxHeight: "source", fps: 30 },
      }),
      makeMedia(),
      "改帧率",
    ],
    ["视频预设遇音频素材", makePreset(), makeMedia({ kind: "audio" }), "只接视频素材"],
    ["图片素材", makePreset(), makeMedia({ kind: "image" }), "图片"],
    ["HEVC 源", makePreset(), makeMedia({ videoCodec: "hevc" }), "只解码 H.264"],
    [
      "音频编码器非 AAC",
      makePreset({ audio: { codec: "libmp3lame", bitrateKbps: 320, sampleRate: 48000 } }),
      makeMedia(),
      "AAC-LC",
    ],
    [
      "纯音频预设的音频编码器非 AAC",
      makePreset({ video: null, audio: { codec: "pcm_s16le", bitrateKbps: 0, sampleRate: 48000 } }),
      makeMedia(),
      "AAC-LC",
    ],
    ["音频源编码非 AAC", makePreset(), makeMedia({ audioCodec: "mp3" }), "只解码 AAC"],
    ["源无音轨而预设要重编码", makePreset(), makeMedia({ hasAudio: false, audioCodec: "" }), "无音轨"],
    [
      "改采样率",
      makePreset({ audio: { codec: "aac", bitrateKbps: 256, sampleRate: 44100 } }),
      makeMedia({ sampleRate: 48000 }),
      "改采样率",
    ],
    ["多声道源", makePreset(), makeMedia({ channels: 6 }), "单/双声道"],
    ["源采样率未知", makePreset(), makeMedia({ sampleRate: 0 }), "采样率未知"],
    [
      "纯音频预设无音频设置（剥光）",
      makePreset({ video: null, audio: null }),
      makeMedia(),
      "空输出",
    ],
  ])("%s", (_name, preset, media, needle) => {
    const built = buildYeTranscodeParams(preset, media);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.error).toContain(needle);
      // 文案可操作：指路 ffmpeg 引擎（或给出预设侧改法）
      expect(built.error).toContain("ffmpeg");
    }
  });
});
