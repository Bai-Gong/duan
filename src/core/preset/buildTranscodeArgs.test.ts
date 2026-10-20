/**
 * buildTranscodeArgs 测试：锁「所见即所转」的关键翻译点。
 * 重点防回归：
 * - 收尾五件套固定（-y -progress pipe:1 -nostats outPath），Rust 进度解析依赖它；
 * - 缩放只降不升（源高 ≤ 目标高不动），maxHeight="source" 永不缩放；
 * - 码率/crf 两种码控互斥；pcm_s16le 不带 -b:a；
 * - 纯音频预设剥视频（-vn）、无音频输出明确禁声（-an），不让 ffmpeg 自选默认编码器；
 * - 图片素材拒绝（MVP 边界）。
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_PRESETS } from "./builtin";
import { buildTranscodeArgs } from "./buildTranscodeArgs";
import type { MediaInfo, Preset } from "./types";

function makeMedia(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path: "C:/media/素材.mp4",
    kind: "video",
    height: 1080,
    hasAudio: true,
    ...overrides,
  };
}

function builtin(id: string): Preset {
  const p = BUILTIN_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`测试引用的内置预设不存在：${id}`);
  return p;
}

/** 取 ok 分支的 args；断言失败时先把 ok 报出来。 */
function argsOf(r: ReturnType<typeof buildTranscodeArgs>): string[] {
  if (!r.ok) throw new Error(`预期成功分支，实际被拒：${r.error}`);
  return r.args;
}

describe("内置预设集", () => {
  it("≥6 个且 id 唯一", () => {
    expect(BUILTIN_PRESETS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(BUILTIN_PRESETS.map((p) => p.id)).size).toBe(BUILTIN_PRESETS.length);
  });
});

describe("buildTranscodeArgs", () => {
  it("码率视频预设：-i 源 + 编码/码控/音频段，收尾五件套", () => {
    const args = argsOf(buildTranscodeArgs(builtin("builtin:h264-1080p-high"), makeMedia(), "C:/out/x.mp4"));
    expect(args.slice(0, 2)).toEqual(["-i", "C:/media/素材.mp4"]);
    expect(args.join(" ")).toContain("-c:v libx264 -b:v 12000k -maxrate 12000k -bufsize 24000k");
    expect(args.join(" ")).toContain("-c:a aac -b:a 256k -ar 48000");
    // 源高 1080 ＝ 目标 1080：不缩放
    expect(args).not.toContain("-vf");
    // fps null 保留源帧率：无 -r
    expect(args).not.toContain("-r");
    expect(args.slice(-5)).toEqual(["-y", "-progress", "pipe:1", "-nostats", "C:/out/x.mp4"]);
  });

  it("2160p 源配 1080p 档：-vf scale=-2:1080 仅降采样", () => {
    const args = argsOf(
      buildTranscodeArgs(builtin("builtin:h264-1080p-mid"), makeMedia({ height: 2160 }), "o.mp4"),
    );
    expect(args).toContain("-vf");
    expect(args.join(" ")).toContain("-vf scale=-2:1080");
  });

  it("720p 源配 1080p 档：不升采样", () => {
    const args = argsOf(
      buildTranscodeArgs(builtin("builtin:h264-1080p-mid"), makeMedia({ height: 720 }), "o.mp4"),
    );
    expect(args).not.toContain("-vf");
  });

  it("720p 源配 720p 档：源高＝目标高也不动", () => {
    const args = argsOf(buildTranscodeArgs(builtin("builtin:h264-720p"), makeMedia({ height: 720 }), "o.mp4"));
    expect(args).not.toContain("-vf");
  });

  it("crf 预设（H.265）：有 -crf、无 -b:v/-maxrate/-bufsize", () => {
    const args = argsOf(buildTranscodeArgs(builtin("builtin:h265-1080p"), makeMedia({ height: 2160 }), "o.mp4"));
    const joined = args.join(" ");
    expect(joined).toContain("-c:v libx265 -crf 24");
    expect(args).not.toContain("-b:v");
    expect(args).not.toContain("-maxrate");
    expect(args).not.toContain("-bufsize");
    expect(joined).toContain("-vf scale=-2:1080"); // crf 与缩放互不干扰
  });

  it("maxHeight=source：永不缩放（2160p 源也不动）", () => {
    const p: Preset = {
      id: "test:source-height",
      name: "源高",
      category: "视频",
      builtin: false,
      container: "mp4",
      video: { codec: "libx264", rate: { mode: "crf", crf: 20 }, maxHeight: "source", fps: null },
      audio: null,
    };
    const args = argsOf(buildTranscodeArgs(p, makeMedia({ height: 2160 }), "o.mp4"));
    expect(args).not.toContain("-vf");
  });

  it("fps 指定 30：输出 -r 30", () => {
    const p: Preset = {
      id: "test:fps30",
      name: "30fps",
      category: "视频",
      builtin: false,
      container: "mp4",
      video: { codec: "libx264", rate: { mode: "crf", crf: 20 }, maxHeight: 1080, fps: 30 },
      audio: null,
    };
    const args = argsOf(buildTranscodeArgs(p, makeMedia(), "o.mp4"));
    expect(args.join(" ")).toContain("-r 30");
  });

  it("纯音频预设（MP3）遇视频源：-vn 剥视频 + libmp3lame 320k 44100", () => {
    const args = argsOf(buildTranscodeArgs(builtin("builtin:mp3-320k"), makeMedia(), "C:/out/x.mp3"));
    const joined = args.join(" ");
    expect(args).toContain("-vn");
    expect(joined).toContain("-c:a libmp3lame -b:a 320k -ar 44100");
    expect(args).not.toContain("-c:v");
    expect(args).not.toContain("-an");
  });

  it("纯音频预设遇纯音频源：无 -vn（无视频流可剥）、无任何视频参数", () => {
    const args = argsOf(
      buildTranscodeArgs(builtin("builtin:mp3-320k"), makeMedia({ kind: "audio", height: 0 }), "x.mp3"),
    );
    expect(args).not.toContain("-vn");
    expect(args.join(" ")).not.toContain("-c:v");
  });

  it("WAV PCM：-c:a pcm_s16le 不带 -b:a（码率由采样率×位深决定）", () => {
    const args = argsOf(buildTranscodeArgs(builtin("builtin:wav-pcm"), makeMedia(), "x.wav"));
    const joined = args.join(" ");
    expect(joined).toContain("-c:a pcm_s16le -ar 48000");
    expect(args).not.toContain("-b:a");
  });

  it("源无音频 + 含音频预设：音频段整个跳过、无 -an", () => {
    const args = argsOf(
      buildTranscodeArgs(builtin("builtin:h264-1080p-mid"), makeMedia({ hasAudio: false }), "o.mp4"),
    );
    const joined = args.join(" ");
    expect(joined).not.toContain("-c:a");
    expect(args).not.toContain("-an");
  });

  it("视频预设遇纯音频源：视频段跳过（产物只含音轨），音频照预设编", () => {
    const args = argsOf(
      buildTranscodeArgs(builtin("builtin:h264-1080p-mid"), makeMedia({ kind: "audio", height: 0 }), "o.mp4"),
    );
    const joined = args.join(" ");
    expect(joined).not.toContain("-c:v");
    expect(joined).toContain("-c:a aac -b:a 192k -ar 48000");
  });

  it("预设 audio=null 且源有音频：-an 明确禁声", () => {
    const p: Preset = {
      id: "test:mute",
      name: "静音",
      category: "视频",
      builtin: false,
      container: "mp4",
      video: { codec: "libx264", rate: { mode: "crf", crf: 20 }, maxHeight: 1080, fps: null },
      audio: null,
    };
    const args = argsOf(buildTranscodeArgs(p, makeMedia(), "o.mp4"));
    expect(args).toContain("-an");
    expect(args.join(" ")).not.toContain("-c:a");
  });

  it("图片素材：拒绝（ok:false，MVP 边界）", () => {
    const r = buildTranscodeArgs(
      builtin("builtin:h264-1080p-mid"),
      makeMedia({ kind: "image", hasAudio: false, height: 0 }),
      "o.mp4",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("图片");
  });

  it("非法预设形状：视频设置配非 mp4 容器 / 音视频全空 → 拒绝", () => {
    const badContainer: Preset = {
      id: "test:bad-container",
      name: "坏容器",
      category: "视频",
      builtin: false,
      container: "mp3",
      video: { codec: "libx264", rate: { mode: "crf", crf: 20 }, maxHeight: 1080, fps: null },
      audio: null,
    };
    const r1 = buildTranscodeArgs(badContainer, makeMedia(), "o.mp3");
    expect(r1.ok).toBe(false);

    const empty: Preset = {
      id: "test:empty",
      name: "全空",
      category: "视频",
      builtin: false,
      container: "mp4",
      video: null,
      audio: null,
    };
    const r2 = buildTranscodeArgs(empty, makeMedia(), "o.mp4");
    expect(r2.ok).toBe(false);
  });
});
