/**
 * preset store 测试：自建预设 CRUD 门禁、收藏联动、持久化往返（partialize 只落数据字段）。
 * vitest 跑 node 环境（无 DOM），用 vi.hoisted 在 import store 之前装一个内存 localStorage——
 * persist 中间件在模块加载时就会碰 storage，桩必须先于 import 生效。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
  class MemoryStorage implements Storage {
    private map = new Map<string, string>();
    get length(): number {
      return this.map.size;
    }
    clear(): void {
      this.map.clear();
    }
    getItem(key: string): string | null {
      return this.map.has(key) ? this.map.get(key)! : null;
    }
    key(index: number): string | null {
      return [...this.map.keys()][index] ?? null;
    }
    removeItem(key: string): void {
      this.map.delete(key);
    }
    setItem(key: string, value: string): void {
      this.map.set(key, String(value));
    }
  }
  const storage = new MemoryStorage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage;
  // zustand 5 persist 默认 storage 是 createJSONStorage(() => window.localStorage)：
  // node 环境没有 window，getStorage 抛错时 persist 整体退化为「无存储直通」
  // （连 api.persist 都不挂、写盘变 console.warn）。把 window 指到 globalThis，
  // 让默认解析链落到上面的内存 localStorage——应用运行时（Tauri webview）本就有 window，
  // 这是测试环境补齐，不改 store 行为。
  (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
  return { storage };
});

import { BUILTIN_PRESETS } from "./builtin";
import { PRESET_STORAGE_KEY, findPreset, listAllPresets, usePresetStore } from "./store";
import type { PresetDraft } from "./store";

function makeDraft(overrides: Partial<PresetDraft> = {}): PresetDraft {
  return {
    name: "我的预设",
    category: "视频",
    container: "mp4",
    video: { codec: "libx264", rate: { mode: "crf", crf: 21 }, maxHeight: 720, fps: null },
    audio: { codec: "aac", bitrateKbps: 192, sampleRate: 48_000 },
    ...overrides,
  };
}

function state() {
  return usePresetStore.getState();
}

/** store 是模块级单例，每个用例从干净状态出发（同步清掉持久化痕迹）。 */
function resetStore() {
  usePresetStore.setState({ customPresets: [], favorites: [], defaultOutputDir: "" });
  testEnv.storage.clear();
}

beforeEach(resetStore);

describe("自建预设 CRUD", () => {
  it("addPreset：返回带 id 的完整预设、builtin 恒 false、入列表", () => {
    const added = state().addPreset(makeDraft());
    expect(added.id).toBeTypeOf("string");
    expect(added.builtin).toBe(false);
    expect(state().customPresets).toHaveLength(1);
    expect(state().customPresets[0]).toEqual(added);
  });

  it("updatePreset：补丁合并，id/builtin 改不动", () => {
    const added = state().addPreset(makeDraft());
    // Partial<Preset> 本就允许塞 id/builtin，身份字段就算塞进来也无效
    state().updatePreset(added.id, { name: "改名", id: "builtin:h264-720p", builtin: true });
    const updated = state().customPresets.find((p) => p.id === added.id)!;
    expect(updated.name).toBe("改名");
    expect(updated.id).toBe(added.id);
    expect(updated.builtin).toBe(false);
  });

  it("updatePreset 内置 id：no-op（内置是常量不许改）", () => {
    state().addPreset(makeDraft());
    state().updatePreset("builtin:h264-720p", { name: "篡改" });
    // 内置常量本就不可变；自建不受影响
    expect(state().customPresets).toHaveLength(1);
    expect(state().customPresets[0].name).toBe("我的预设");
    expect(BUILTIN_PRESETS.find((p) => p.id === "builtin:h264-720p")!.name).toBe("H.264 720p");
  });

  it("removePreset：删除并同步清掉它的收藏（防悬空 id）", () => {
    const added = state().addPreset(makeDraft());
    state().toggleFavorite(added.id);
    expect(state().favorites).toContain(added.id);
    state().removePreset(added.id);
    expect(state().customPresets).toHaveLength(0);
    expect(state().favorites).not.toContain(added.id);
  });

  it("removePreset 内置 id：no-op", () => {
    state().removePreset("builtin:wav-pcm");
    expect(state().customPresets).toHaveLength(0);
    expect(BUILTIN_PRESETS.length).toBeGreaterThanOrEqual(6); // 常量原封不动
  });
});

describe("收藏与默认输出目录", () => {
  it("toggleFavorite：开/关往返，内置 id 也能收藏", () => {
    state().toggleFavorite("builtin:mp3-320k");
    expect(state().favorites).toEqual(["builtin:mp3-320k"]);
    state().toggleFavorite("builtin:mp3-320k");
    expect(state().favorites).toEqual([]);
  });

  it("setDefaultOutputDir：直接落值（空串＝未设置）", () => {
    state().setDefaultOutputDir("D:/转码输出");
    expect(state().defaultOutputDir).toBe("D:/转码输出");
    state().setDefaultOutputDir("");
    expect(state().defaultOutputDir).toBe("");
  });
});

describe("presetId 解析（队列引擎对接面）", () => {
  it("listAllPresets：内置在前、自建在后", () => {
    const added = state().addPreset(makeDraft());
    const all = listAllPresets(state().customPresets);
    expect(all).toHaveLength(BUILTIN_PRESETS.length + 1);
    expect(all[0].id).toBe(BUILTIN_PRESETS[0].id);
    expect(all[all.length - 1]).toEqual(added);
  });

  it("findPreset：内置/自建都能找到；被删的自建返回 undefined（队列按失效处理）", () => {
    expect(findPreset([], "builtin:h264-720p")!.name).toBe("H.264 720p");
    const added = state().addPreset(makeDraft());
    expect(findPreset(state().customPresets, added.id)).toEqual(added);
    state().removePreset(added.id);
    expect(findPreset(state().customPresets, added.id)).toBeUndefined();
  });
});

describe("持久化（localStorage）", () => {
  it("partialize：盘上只有四个数据字段（含 M3 接线的 engine），actions 不落盘", () => {
    state().addPreset(makeDraft());
    state().toggleFavorite("builtin:mp3-320k");
    state().setDefaultOutputDir("D:/转码输出");
    const raw = testEnv.storage.getItem(PRESET_STORAGE_KEY);
    expect(raw).toBeTruthy();
    // 真实 zustand persist 的盘上格式是 { state: <partialize 产物>, version } 信封
    // （zustand/esm/middleware.mjs setItem），partialize 的字段门禁看 state 内层。
    const saved = JSON.parse(raw!) as { state: Record<string, unknown>; version: number };
    expect(Object.keys(saved.state).sort()).toEqual([
      "customPresets",
      "defaultOutputDir",
      "engine",
      "favorites",
    ]);
    expect(saved.version).toBe(2);
    expect(saved.state.favorites).toEqual(["builtin:mp3-320k"]);
    expect(saved.state.defaultOutputDir).toBe("D:/转码输出");
  });

  it("rehydrate：重开应用后自建预设/收藏/默认输出目录原样恢复", async () => {
    const added = state().addPreset(makeDraft({ name: "跨重启" }));
    state().toggleFavorite(added.id);
    state().setDefaultOutputDir("D:/转码输出");
    const snapshot = testEnv.storage.getItem(PRESET_STORAGE_KEY)!;

    // 模拟重启：状态清空（内存态没了），盘上快照还在
    usePresetStore.setState({ customPresets: [], favorites: [], defaultOutputDir: "" });
    testEnv.storage.setItem(PRESET_STORAGE_KEY, snapshot);
    await usePresetStore.persist.rehydrate();

    expect(state().customPresets.map((p) => p.name)).toEqual(["跨重启"]);
    expect(state().favorites).toEqual([added.id]);
    expect(state().defaultOutputDir).toBe("D:/转码输出");
  });
});

it("migrates the engine preference while preserving unsupported preset data",async()=>{
  const preset={...makeDraft({container:"mp3",video:null,audio:{codec:"libmp3lame",sampleRate:44100,bitrateKbps:320}}),id:"saved-old",builtin:false};
  testEnv.storage.setItem(PRESET_STORAGE_KEY,JSON.stringify({version:1,state:{engine:"ffmpeg",customPresets:[preset],favorites:[preset.id],defaultOutputDir:"D:/saved"}}));
  await usePresetStore.persist.rehydrate();
  expect(state().engine).toBe("ye");expect(state().legacyEngine).toBe("ffmpeg");
  expect(state().customPresets).toEqual([preset]);expect(state().favorites).toEqual([preset.id]);expect(state().defaultOutputDir).toBe("D:/saved");
});
