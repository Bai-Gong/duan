/**
 * 命名纯函数测试：模板替换、Windows 非法字符清洗、冲突自增、
 * 大小写/分隔符不敏感的撞名比较。
 */
import { describe, expect, it } from "vitest";
import {
  baseNameWithoutExt,
  buildOutputFileName,
  resolveOutputPath,
  sanitizeWindowsName,
} from "./naming";

describe("sanitizeWindowsName", () => {
  it("非法字符与控制字符逐个替换为下划线", () => {
    expect(sanitizeWindowsName('a<b>c:"d/e\\f|g?h*i')).toBe("a_b_c__d_e_f_g_h_i");
    expect(sanitizeWindowsName("x\u0000y\u001fz")).toBe("x_y_z");
  });

  it("结尾的点/空格裁掉；名字中间的点保留（预设名 H.264 可读）", () => {
    expect(sanitizeWindowsName("H.264 1080p. ")).toBe("H.264 1080p");
    expect(sanitizeWindowsName("素材 A.")).toBe("素材 A");
  });

  it("空串原样返回", () => {
    expect(sanitizeWindowsName("")).toBe("");
  });
});

describe("baseNameWithoutExt", () => {
  it("Windows 反斜杠与正斜杠都取 basename", () => {
    expect(baseNameWithoutExt("D:\\media\\素材 A.mp4")).toBe("素材 A");
    expect(baseNameWithoutExt("/home/u/clip.mov")).toBe("clip");
  });

  it("只去最后一个扩展名（多点名字保留前面的点）", () => {
    expect(baseNameWithoutExt("D:/x/clip.final.mov")).toBe("clip.final");
  });

  it("无扩展名、点在首位的隐藏文件风格均不动", () => {
    expect(baseNameWithoutExt("D:/x/无扩展名")).toBe("无扩展名");
    expect(baseNameWithoutExt("D:/x/.gitignore")).toBe(".gitignore");
  });
});

describe("buildOutputFileName", () => {
  it("三段模板 {name}.{presetLabel}.{ext}", () => {
    expect(buildOutputFileName("D:/m/素材 A.mp4", "H.264 1080p", "mp4")).toBe(
      "素材 A.H.264 1080p.mp4",
    );
  });

  it("源名与预设名里的非法字符都清洗", () => {
    expect(buildOutputFileName("D:/m/录像:2024.mp4", "MP3 320k", "mp3")).toBe(
      "录像_2024.MP3 320k.mp3",
    );
  });

  it("ext 带前置点也归一", () => {
    expect(buildOutputFileName("D:/m/a.mp4", "WAV PCM", ".wav")).toBe("a.WAV PCM.wav");
  });
});

describe("resolveOutputPath", () => {
  it("无冲突直接用基础名；输出目录结尾分隔符去掉", () => {
    expect(resolveOutputPath("D:/out/", "D:/m/素材 B.mp4", "H.264 1080p", "mp4", [])).toBe(
      "D:/out/素材 B.H.264 1080p.mp4",
    );
  });

  it("撞名自增 -1：后缀加在预设名后、扩展名前", () => {
    const existing = ["D:/out/素材 A.H.264 1080p.mp4"];
    expect(resolveOutputPath("D:/out", "D:/m/素材 A.mp4", "H.264 1080p", "mp4", existing)).toBe(
      "D:/out/素材 A.H.264 1080p-1.mp4",
    );
  });

  it("分隔符与大小写不同的写法也算撞名（Windows 语义）", () => {
    const existing = [
      "D:\\out\\素材 A.H.264 1080p.mp4", // 反斜杠
      "D:/OUT/素材 A.H.264 1080p-1.MP4", // 大小写不同
    ];
    expect(resolveOutputPath("D:/out", "D:/m/素材 A.mp4", "H.264 1080p", "mp4", existing)).toBe(
      "D:/out/素材 A.H.264 1080p-2.mp4",
    );
  });

  it("同批同名也逐个让位（existing 含刚生成的那条）", () => {
    const existing: string[] = [];
    const first = resolveOutputPath("D:/out", "D:/m/素材 A.mp4", "MP3 320k", "mp3", existing);
    existing.push(first);
    const second = resolveOutputPath("D:/out", "D:/m/素材 A.mp4", "MP3 320k", "mp3", existing);
    expect(second).toBe("D:/out/素材 A.MP3 320k-1.mp3");
  });
});
