/**
 * 预设浏览器（左区，产品分析「主界面四大区」之一）：
 * 分类树＝内置分类（按内置清单归类）＋「我的预设」＋「收藏」，关键字过滤，
 * 星标切换收藏，点选预设即「当前预设」——新入队任务套用它。
 * currentPresetId 是队列会话 UI 态，由 AppShell 持有（core 两个 store 均无此字段），
 * 经 props 下发；树/列表自建不进 fang（fang ui/ 尚无控件，成熟后按 R5 反哺）。
 */
import { useEffect, useMemo, useState } from "react";
import { DockPanel } from "@baigong/fang";
import { Search, Star } from "lucide-react";
import { BUILTIN_PRESETS } from "../../core/preset/builtin";
import { usePresetStore } from "../../core/preset/store";
import type { AudioCodec, Preset, VideoCodec } from "../../core/preset/types";
import "./preset-browser.css";
import { checkPresetYe } from "../../core/preset/checkPresetYe";

/** 编码器名 → 人话标签（仅展示用，不改写预设数据）。 */
const VIDEO_CODEC_LABEL: Record<VideoCodec, string> = {
  libx264: "H.264",
  libx265: "H.265",
};

const AUDIO_CODEC_LABEL: Record<AudioCodec, string> = {
  aac: "AAC",
  libmp3lame: "MP3",
  pcm_s16le: "PCM",
};

/** 预设摘要（列表行的次行小字）：容器 · 编码/码控 · 音频。 */
export function presetSummary(preset: Preset): string {
  const container = preset.container.toUpperCase();
  if (preset.video) {
    const codec = VIDEO_CODEC_LABEL[preset.video.codec];
    const height = preset.video.maxHeight === "source" ? "源高" : `${preset.video.maxHeight}p`;
    const rate =
      preset.video.rate.mode === "bitrate" ? `${Math.round(preset.video.rate.bitrateKbps / 1000)} Mbps` : `CRF ${preset.video.rate.crf}`;
    return `${container} · ${codec} ${height} · ${rate}`;
  }
  if (preset.audio) {
    const codec = AUDIO_CODEC_LABEL[preset.audio.codec];
    const rate = preset.audio.codec === "pcm_s16le" ? "无损" : `${preset.audio.bitrateKbps} kbps`;
    return `${container} · ${codec} ${rate}`;
  }
  return container;
}

interface PresetSection {
  key: string;
  label: string;
  presets: Preset[];
}

interface PresetBrowserPanelProps {
  /** 当前预设 id（AppShell 会话态）；null＝尚未选择。 */
  currentPresetId: string | null;
  /** 点选预设 → 设为当前预设。 */
  onSelectPreset: (presetId: string) => void;
}

export function PresetBrowserPanel({ currentPresetId, onSelectPreset }: PresetBrowserPanelProps) {
  const customPresets = usePresetStore((s) => s.customPresets);
  const favorites = usePresetStore((s) => s.favorites);
  const toggleFavorite = usePresetStore((s) => s.toggleFavorite);
  const [keyword, setKeyword] = useState("");
  const [availability,setAvailability]=useState<Record<string,string[]>>({});
  useEffect(()=>{
    let active=true;
    void Promise.all([...BUILTIN_PRESETS,...customPresets].map(async(p)=>[p.id,await checkPresetYe(p)] as const))
      .then((entries)=>{if(active)setAvailability(Object.fromEntries(entries));});
    return ()=>{active=false;};
  },[customPresets]);

  const sections = useMemo<PresetSection[]>(() => {
    const kw = keyword.trim().toLowerCase();
    const match = (p: Preset) =>
      kw === "" || p.name.toLowerCase().includes(kw) || p.category.toLowerCase().includes(kw);

    // 内置分类：按内置清单出现次序去重（当前为「视频」「音频」，新增分类自动成组）
    const categories: string[] = [];
    for (const p of BUILTIN_PRESETS) {
      if (!categories.includes(p.category)) categories.push(p.category);
    }
    const list: PresetSection[] = categories.map((category) => ({
      key: `builtin:${category}`,
      label: category,
      presets: BUILTIN_PRESETS.filter((p) => p.category === category && match(p)),
    }));

    const mine = customPresets.filter(match);
    list.push({
      key: "custom",
      label: "我的预设",
      presets: mine,
    });

    const favorited = [...BUILTIN_PRESETS, ...customPresets].filter((p) => favorites.includes(p.id) && match(p));
    list.push({
      key: "favorites",
      label: "收藏",
      presets: favorited,
    });
    return list;
  }, [customPresets, favorites, keyword]);

  const hasAnyMatch = sections.some((s) => s.presets.length > 0);

  return (
    <DockPanel title="预设浏览器" collapsed={false} className="preset-browser-panel" style={{ flex: 1, minHeight: 0 }}>
      <div className="preset-browser">
        <div className="preset-browser__filter">
          <Search size={13} aria-hidden />
          <input
            type="text"
            className="preset-browser__input"
            placeholder="过滤预设名称 / 分类"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            aria-label="关键字过滤"
          />
        </div>
        <div className="preset-browser__tree">
          {!hasAnyMatch ? (
            <p className="preset-browser__empty">无匹配预设</p>
          ) : (
            sections.map((section) => (
              <section key={section.key} className="preset-browser__group">
                <h4 className="preset-browser__group-title">
                  {section.label}
                  <span className="preset-browser__group-count">{section.presets.length}</span>
                </h4>
                {section.presets.length === 0 ? (
                  <p className="preset-browser__group-empty">暂无</p>
                ) : (
                  <ul className="preset-browser__list">
                    {section.presets.map((preset) => {
                      const isCurrent = preset.id === currentPresetId;
                      const isFavorite = favorites.includes(preset.id);
                      return (
                        <li
                          key={`${section.key}:${preset.id}`}
                          className={`preset-item${isCurrent ? " preset-item--current" : ""}`}
                        >
                          <button
                            type="button"
                            className="preset-item__select"
                            onClick={() => onSelectPreset(preset.id)}
                            title={`设为当前预设：${preset.name}`}
                          >
                            <span className="preset-item__name" title={availability[preset.id]?.join("；")}>{preset.name}{availability[preset.id]?.length ? " · 暂不可执行" : ""}</span>
                            <span className="preset-item__meta">{presetSummary(preset)}</span>
                          </button>
                          <button
                            type="button"
                            className={`icon-btn preset-item__star${isFavorite ? " preset-item__star--on" : ""}`}
                            onClick={() => toggleFavorite(preset.id)}
                            aria-label={isFavorite ? `取消收藏 ${preset.name}` : `收藏 ${preset.name}`}
                            title={isFavorite ? "取消收藏" : "收藏"}
                          >
                            <Star size={14} aria-hidden fill={isFavorite ? "currentColor" : "none"} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            ))
          )}
        </div>
      </div>
    </DockPanel>
  );
}
