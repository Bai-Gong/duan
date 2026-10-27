/**
 * 预设仓库：自建预设 CRUD + 收藏集 + 默认输出目录，zustand + persist（localStorage）。
 * 只持久化这三样（MVP 边界：队列不持久化）；内置预设是代码常量（builtin.ts），不进 store。
 * 导出设置对话框与本 store 读写同一份数据——「另存为预设」走 addPreset，改档走 updatePreset。
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { BUILTIN_PRESETS } from "./builtin";
import type { Preset } from "./types";

/** 新建自建预设入参：id/builtin 由 store 决定（调用方造不出内置预设）。 */
export type PresetDraft = Omit<Preset, "id" | "builtin">;

export interface PresetStoreState {
  customPresets: Preset[];
  /** 收藏的预设 id（内置或自建皆可，预设浏览器置顶展示）。 */
  favorites: string[];
  /** 默认输出目录；""＝未设置（由命名模块按源文件所在目录兜底）。 */
  defaultOutputDir: string;
  /**
   * 转码引擎二选一（M3 接线轨）：ffmpeg＝子进程（回退/oracle），
   * ye＝进程内（H.264 解码+编码、音频直通；能力面外由翻译层提前拒绝）。
   */
  engine: "ffmpeg" | "ye";

  /** 入库并返回带 id 的完整预设（id＝crypto.randomUUID）。 */
  addPreset(draft: PresetDraft): Preset;
  /** 只改自建预设；内置 id 或未知 id → no-op（内置是常量不许改）。 */
  updatePreset(id: string, patch: Partial<Preset>): void;
  /** 删自建预设并同步清掉它的收藏（防悬空 id）。 */
  removePreset(id: string): void;
  toggleFavorite(id: string): void;
  setDefaultOutputDir(dir: string): void;
  setEngine(engine: "ffmpeg" | "ye"): void;
}

export const PRESET_STORAGE_KEY = "duan.preset";

export const usePresetStore = create<PresetStoreState>()(
  persist(
    (set) => ({
      customPresets: [],
      favorites: [],
      defaultOutputDir: "",
      engine: "ffmpeg",

      addPreset: (draft) => {
        const preset: Preset = { ...draft, id: crypto.randomUUID(), builtin: false };
        set((s) => ({ customPresets: [...s.customPresets, preset] }));
        return preset;
      },

      updatePreset: (id, patch) => {
        set((s) => ({
          // id/builtin 强制写回原值：patch 改不动身份字段
          customPresets: s.customPresets.map((p) =>
            p.id === id ? { ...p, ...patch, id: p.id, builtin: false } : p,
          ),
        }));
      },

      removePreset: (id) => {
        set((s) => ({
          customPresets: s.customPresets.filter((p) => p.id !== id),
          favorites: s.favorites.filter((f) => f !== id),
        }));
      },

      toggleFavorite: (id) => {
        set((s) => ({
          favorites: s.favorites.includes(id)
            ? s.favorites.filter((f) => f !== id)
            : [...s.favorites, id],
        }));
      },

      setDefaultOutputDir: (dir) => set({ defaultOutputDir: dir }),

      setEngine: (engine) => set({ engine }),
    }),
    {
      name: PRESET_STORAGE_KEY,
      version: 1,
      // 只落数据字段，actions 不进 localStorage
      partialize: (s) => ({
        customPresets: s.customPresets,
        favorites: s.favorites,
        defaultOutputDir: s.defaultOutputDir,
        engine: s.engine,
      }),
    },
  ),
);

/** 全量预设（内置在前、自建在后）：预设浏览器列表与 presetId 解析共用。 */
export function listAllPresets(customPresets: readonly Preset[]): Preset[] {
  return [...BUILTIN_PRESETS, ...customPresets];
}

/**
 * 按 id 找预设：队列引擎把 QueueItem.presetId 解析成 Preset 的唯一入口。
 * 找不到（自建预设被删而队列还挂着旧 id）返回 undefined，由调用方按失效处理。
 */
export function findPreset(customPresets: readonly Preset[], id: string): Preset | undefined {
  return listAllPresets(customPresets).find((p) => p.id === id);
}
