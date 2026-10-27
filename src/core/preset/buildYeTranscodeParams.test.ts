/**
 * buildYeTranscodeParams 行为测试：锁住「能力面内如实翻译、能力面外明确拒绝」——
 * 缩放语义与 buildTranscodeArgs 一致（仅降采样、等比取偶），拒绝文案可操作
 * （指路 ffmpeg 引擎或预设改法），不静默降级。
 */
import { describe, expect, it } from "vitest";
import { buildYeTranscodeParams } from "./buildYeTranscodeParams";
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

function makeMedia(overrides: Partial<Parameters<typeof buildYeTranscodeParams>[1]> = {}) {
  return { kind: "video" as const, width: 1920, height: 1080, videoCodec: "h264", ...overrides };
}

describe("能力面内翻译", () => {
  it("CRF + 源高不超上限：保持原尺寸，crf 透传", () => {
    const built = buildYeTranscodeParams(makePreset(), makeMedia());
    expect(built).toEqual({ ok: true, width: null, height: null, crf: 23 });
  });

  it("maxHeight 触发仅降采样：等比取偶宽", () => {
    const preset = makePreset({
      video: { codec: "libx264", rate: { mode: "crf", crf: 20 }, maxHeight: 720, fps: null },
    });
    // 1920x1080 → 720：宽 1920*720/1080=1280（已偶）
    expect(buildYeTranscodeParams(preset, makeMedia())).toEqual({
      ok: true,
      width: 1280,
      height: 720,
      crf: 20,
    });
    // 奇宽源 858x480 → 360：宽 858*360/480=643.5 → 644 取偶
    expect(buildYeTranscodeParams(preset, makeMedia({ width: 858, height: 480 }))).toEqual({
      ok: true,
      width: 644,
      height: 360,
      crf: 20,
    });
  });

  it("源高≤目标高不放大（与 ffmpeg 引擎的仅降采样语义一致）", () => {
    const preset = makePreset({
      video: { codec: "libx264", rate: { mode: "crf", crf: 23 }, maxHeight: 1080, fps: null },
    });
    expect(buildYeTranscodeParams(preset, makeMedia({ width: 1280, height: 720 }))).toEqual({
      ok: true,
      width: null,
      height: null,
      crf: 23,
    });
  });

  it("源编码 avc1（MP4 常见 codec_name 变体）按 H.264 放行", () => {
    expect(buildYeTranscodeParams(makePreset(), makeMedia({ videoCodec: "avc1" })).ok).toBe(true);
  });
});

describe("能力面外明确拒绝（不静默降级）", () => {
  it.each<[string, Preset, ReturnType<typeof makeMedia>, string]>([
    ["非 MP4 容器", makePreset({ container: "mp3" }), makeMedia(), "只输出 MP4"],
    ["纯音频预设", makePreset({ video: null }), makeMedia(), "AAC 重编码"],
    ["剥音轨预设", makePreset({ audio: null }), makeMedia(), "不做剥轨"],
    [
      "H.265 编码",
      makePreset({
        video: { codec: "libx265", rate: { mode: "crf", crf: 23 }, maxHeight: "source", fps: null },
      }),
      makeMedia(),
      "只编码 H.264",
    ],
    [
      "目标码率模式",
      makePreset({
        video: { codec: "libx264", rate: { mode: "bitrate", bitrateKbps: 8000 }, maxHeight: "source", fps: null },
      }),
      makeMedia(),
      "目标码率",
    ],
    [
      "改帧率",
      makePreset({
        video: { codec: "libx264", rate: { mode: "crf", crf: 23 }, maxHeight: "source", fps: 30 },
      }),
      makeMedia(),
      "改帧率",
    ],
    ["非视频素材", makePreset(), makeMedia({ kind: "audio" }), "只接视频"],
    ["HEVC 源", makePreset(), makeMedia({ videoCodec: "hevc" }), "只解码 H.264"],
  ])("%s", (_name, preset, media, needle) => {
    const built = buildYeTranscodeParams(preset, media);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.error).toContain(needle);
      // 文案可操作：指路 ffmpeg 引擎（真码控/改帧率也给了预设侧改法）
      expect(built.error).toContain("ffmpeg");
    }
  });
});
