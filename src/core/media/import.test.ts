/**
 * 导入纯函数与编排测试：白名单口径（锻清单 23 扩展名精确锁定、gif 有意不在）、
 * 目录单层展开、绝对路径去重（大小写/分隔符不敏感）、probe 分拣
 * （图片拒入队、失败跳过不拖垮整批、队列已有路径不再探测）。
 * plugin-dialog/plugin-fs 未随骨架安装：相关入口走动态 import，本文件不触达；
 * 目录展开逻辑以 expandEntriesToPaths 纯函数锁定，真实 readDir 链路集成期验证。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaInfo } from "./probe";
import { probeMedia } from "./probe";
import {
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  IMPORT_FILTERS,
  VIDEO_EXTENSIONS,
  dedupePaths,
  expandEntriesToPaths,
  extensionOf,
  importPaths,
  isAllowedPath,
  pathKey,
} from "./import";

vi.mock("./probe", () => ({ probeMedia: vi.fn() }));

/** 造探测结果：缺省一个 1080p h264/aac 视频，可覆写。 */
function makeInfo(over: Partial<MediaInfo> = {}): MediaInfo {
  return {
    durationUs: 1_000_000,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    kind: "video",
    videoCodec: "h264",
    audioCodec: "aac",
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    sampleRate: 48000,
    channels: 2,
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(probeMedia).mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("白名单口径（锻规格清单，23 个扩展名：视频 11 + 音频 7 + 图片 5）", () => {
  it("三类扩展名全集精确锁定", () => {
    expect(VIDEO_EXTENSIONS).toEqual([
      "mp4", "mov", "mkv", "avi", "webm", "m4v", "mpg", "mpeg", "ts", "flv", "wmv",
    ]);
    expect(AUDIO_EXTENSIONS).toEqual(["mp3", "wav", "flac", "aac", "m4a", "ogg", "opus"]);
    expect(IMAGE_EXTENSIONS).toEqual(["png", "jpg", "jpeg", "webp", "bmp"]);
  });

  it("对话框过滤器全集无重复", () => {
    expect(IMPORT_FILTERS[0].extensions).toHaveLength(23);
    expect(new Set(IMPORT_FILTERS[0].extensions).size).toBe(23);
  });

  it("大小写与分隔符不敏感", () => {
    expect(isAllowedPath("D:/a/b.MP4")).toBe(true);
    expect(isAllowedPath("C:\\x\\y.mov")).toBe(true);
    expect(isAllowedPath("p.Jpeg")).toBe(true);
  });

  it("名单外拒绝：gif 有意不在锻名单（与 jian 不同，按锻规格）", () => {
    expect(isAllowedPath("a.gif")).toBe(false);
    expect(isAllowedPath("a.txt")).toBe(false);
    expect(isAllowedPath("a.exe")).toBe(false);
    expect(isAllowedPath("无扩展名")).toBe(false);
  });
});

describe("extensionOf 边缘形态", () => {
  it("多点取最后一段并小写", () => {
    expect(extensionOf("a.b.mp4")).toBe("mp4");
    expect(extensionOf("D:\\x\\Y.MOV")).toBe("mov");
  });

  it("无扩展名/隐藏文件/点结尾返回空串", () => {
    expect(extensionOf("clip")).toBe("");
    expect(extensionOf("clip.")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
  });
});

describe("绝对路径去重（保首见顺序）", () => {
  it("重复路径只留首个", () => {
    expect(dedupePaths(["a.mp4", "b.mp3", "a.mp4"])).toEqual(["a.mp4", "b.mp3"]);
  });

  it("大小写与分隔符差异视为同一路径", () => {
    expect(dedupePaths(["D:/A.MP4", "d:/a.mp4"])).toEqual(["D:/A.MP4"]);
    expect(dedupePaths(["D:\\a\\b.mp4", "D:/a/b.mp4"])).toEqual(["D:\\a\\b.mp4"]);
    expect(pathKey("D:\\A\\B.MP4\\")).toBe("d:/a/b.mp4");
  });

  it("existing 参与去重（队列已有路径不重复导入）", () => {
    expect(dedupePaths(["d:/x.mp4"], ["D:/X.mp4"])).toEqual([]);
  });
});

describe("目录单层展开（纯函数）", () => {
  const entries = [
    { name: "sub", isDirectory: true },
    { name: "a.mp4", isDirectory: false },
    { name: "b.mp3", isDirectory: false },
  ];

  it("只取文件条目、拼正斜杠路径、保持目录序", () => {
    expect(expandEntriesToPaths("D:/media", entries)).toEqual(["D:/media/a.mp4", "D:/media/b.mp3"]);
  });

  it("目录带尾分隔符或反斜杠都能拼", () => {
    expect(expandEntriesToPaths("D:/media/", entries)).toEqual(["D:/media/a.mp4", "D:/media/b.mp3"]);
    expect(expandEntriesToPaths("D:\\media\\", entries)).toEqual(["D:/media/a.mp4", "D:/media/b.mp3"]);
  });

  it("空目录返回空数组", () => {
    expect(expandEntriesToPaths("D:/empty", [])).toEqual([]);
  });
});

describe("importPaths 编排", () => {
  it("视频/音频探测成功 → 候选按输入顺序携带 mediaInfo", async () => {
    vi.mocked(probeMedia).mockImplementation(async (path: string) =>
      path.endsWith(".mp3") ? makeInfo({ kind: "audio", width: 0, height: 0, fps: 0, videoCodec: "", audioCodec: "mp3" }) : makeInfo(),
    );
    const out = await importPaths(["D:/a.mp4", "D:/b.mp3"]);
    expect(out.candidates.map((c) => c.path)).toEqual(["D:/a.mp4", "D:/b.mp3"]);
    expect(out.candidates[0].mediaInfo.kind).toBe("video");
    expect(out.candidates[1].mediaInfo.kind).toBe("audio");
    expect(out.skipped).toEqual([]);
  });

  it("图片探测成功也拒绝入队，元数据附在 skipped 供展示（MVP 边界）", async () => {
    vi.mocked(probeMedia).mockResolvedValue(makeInfo({ kind: "image", durationUs: 0, fps: 0, videoCodec: "png" }));
    const out = await importPaths(["D:/pic.PNG"]);
    expect(out.candidates).toEqual([]);
    expect(out.skipped).toEqual([
      { path: "D:/pic.PNG", reason: "image-not-supported", mediaInfo: expect.objectContaining({ kind: "image" }) },
    ]);
  });

  it("单个探测失败只跳过、不拖垮整批，错误文案带回", async () => {
    vi.mocked(probeMedia).mockImplementation(async (path: string) => {
      if (path.includes("bad")) throw new Error("ffprobe 探测失败（D:/bad.mp4）: 无效数据");
      return makeInfo();
    });
    const out = await importPaths(["D:/bad.mp4", "D:/good.mp4"]);
    expect(out.candidates.map((c) => c.path)).toEqual(["D:/good.mp4"]);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].reason).toBe("probe-failed");
    expect(out.skipped[0].error).toContain("ffprobe 探测失败");
  });

  it("队列已有路径（大小写/分隔符差异）不再探测", async () => {
    vi.mocked(probeMedia).mockResolvedValue(makeInfo());
    const out = await importPaths(["D:/a/x.mp4", "D:/a/y.mp4"], ["d:\\a\\X.mp4"]);
    expect(probeMedia).toHaveBeenCalledTimes(1);
    expect(probeMedia).toHaveBeenCalledWith("D:/a/y.mp4");
    expect(out.candidates.map((c) => c.path)).toEqual(["D:/a/y.mp4"]);
  });

  it("非白名单且当目录打不开的路径按 unsupported 上报", async () => {
    // 测试环境未装 plugin-fs，动态 import 失败与生产 readDir 失败同样落入 null → unsupported
    const out = await importPaths(["D:/notes.txt"]);
    expect(out.candidates).toEqual([]);
    expect(out.skipped).toEqual([{ path: "D:/notes.txt", reason: "unsupported" }]);
    expect(probeMedia).not.toHaveBeenCalled();
  });
});
