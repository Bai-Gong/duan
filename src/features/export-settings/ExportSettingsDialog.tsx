/**
 * 导出设置对话框（产品分析「关键对话框」）：格式/编解码器/码率/分辨率策略/音频，
 * 「另存为预设」写 preset store（addPreset，自建预设持久化），「应用到此任务」
 * 改队列项的预设/覆盖设置。
 *
 * 码控与字段形状严格对齐 core/preset/types（rate 二选一、fps null＝保留源、
 * maxHeight "source"＝永不缩放）；容器决定可用音频编码器（mp4→aac、mp3→libmp3lame、
 * wav→pcm_s16le——与内置预设集合同口径），pcm_s16le 无损不吃码率字段。
 *
 * 应用实现说明：队列 store（模块5）没有「改已有项预设」的动作，这里用
 * remove＋add 重投（对话框只对 waiting 项开放，remove 合法）：输出路径按新设置
 * 重新命名定稿，代价是该项移到队尾——集成期若给 store 补 updateItem 类动作，
 * 替换 applyItemSettings 一处即可。
 */
import { useEffect, useState } from "react";
import { Check, Save, X } from "lucide-react";
import { usePresetStore } from "../../core/preset/store";
import type {
  AudioCodec,
  AudioSettings,
  Container,
  MaxHeight,
  Preset,
  VideoCodec,
  VideoRateControl,
  VideoSettings,
} from "../../core/preset/types";
import { useQueueStore } from "../../core/queue/store";
import type { PresetOverride, QueueItem } from "../../core/queue/types";
import { basenameOf, dirnameOf, effectivePreset, FALLBACK_PRESET } from "../queue-table/QueueTablePanel";
import "./export-settings.css";

/** 容器 → 唯一可用音频编码器（MVP 口径，与内置预设一致）。 */
const AUDIO_CODEC_FOR_CONTAINER: Record<Container, AudioCodec> = {
  mp4: "aac",
  mp3: "libmp3lame",
  wav: "pcm_s16le",
};

/** 表单草稿：数值字段一律字符串（输入可置空，应用时解析＋钳位）。 */
interface Draft {
  container: Container;
  videoEnabled: boolean;
  videoCodec: VideoCodec;
  rateMode: VideoRateControl["mode"];
  bitrateKbps: string;
  crf: string;
  maxHeight: MaxHeight;
  fpsFollowSource: boolean;
  fps: string;
  audioEnabled: boolean;
  audioBitrateKbps: string;
  sampleRate: string;
  presetName: string;
}

function draftFromPreset(preset: Preset | null): Draft {
  const p = preset ?? FALLBACK_PRESET;
  const rateMode: VideoRateControl["mode"] = p.video?.rate.mode ?? "bitrate";
  return {
    container: p.container,
    videoEnabled: p.video !== null,
    videoCodec: p.video?.codec ?? "libx264",
    rateMode,
    bitrateKbps: String(p.video?.rate.mode === "bitrate" ? p.video.rate.bitrateKbps : 8000),
    crf: String(p.video?.rate.mode === "crf" ? p.video.rate.crf : 24),
    maxHeight: p.video?.maxHeight ?? 1080,
    fpsFollowSource: p.video?.fps == null,
    fps: String(p.video?.fps ?? 30),
    audioEnabled: p.audio !== null,
    audioBitrateKbps: String(p.audio?.bitrateKbps || 256),
    sampleRate: String(p.audio?.sampleRate ?? 48_000),
    presetName: "",
  };
}

const clampInt = (raw: string, min: number, max: number): number | null => {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return null;
  return Math.max(min, Math.min(max, n));
};

/** 草稿 → 预设数据段；数值非法时返回 null（按钮侧据此禁用）。 */
function draftToSettings(
  draft: Draft,
): { container: Container; video: VideoSettings | null; audio: AudioSettings | null } | null {
  const audioCodec = AUDIO_CODEC_FOR_CONTAINER[draft.container];
  let video: VideoSettings | null = null;
  if (draft.container === "mp4" && draft.videoEnabled) {
    const rate: VideoRateControl | null =
      draft.rateMode === "bitrate"
        ? (() => {
            const kbps = clampInt(draft.bitrateKbps, 64, 200_000);
            return kbps === null ? null : { mode: "bitrate", bitrateKbps: kbps };
          })()
        : (() => {
            const crf = clampInt(draft.crf, 0, 51);
            return crf === null ? null : { mode: "crf", crf };
          })();
    const fps = draft.fpsFollowSource ? null : clampInt(draft.fps, 1, 240);
    if (rate === null || fps === null) return null;
    video = { codec: draft.videoCodec, rate, maxHeight: draft.maxHeight, fps };
  }
  let audio: AudioSettings | null = null;
  if (draft.audioEnabled) {
    // pcm_s16le 无损：忽略码率字段（置 0，翻译层不产生 -b:a）
    const bitrateKbps =
      audioCodec === "pcm_s16le" ? 0 : (clampInt(draft.audioBitrateKbps, 8, 1000) ?? 0);
    if (audioCodec !== "pcm_s16le" && bitrateKbps === 0) return null;
    const sampleRate = clampInt(draft.sampleRate, 8000, 192_000);
    if (sampleRate === null) return null;
    audio = { codec: audioCodec, bitrateKbps, sampleRate };
  }
  // mp4 全关音轨且无视频没有意义；纯音频容器（mp3/wav）必有音轨
  if (video === null && audio === null) return null;
  if (draft.container !== "mp4" && audio === null) return null;
  return { container: draft.container, video, audio };
}

interface ExportSettingsDialogProps {
  item: QueueItem;
  onClose: () => void;
}

export function ExportSettingsDialog({ item, onClose }: ExportSettingsDialogProps) {
  const customPresets = usePresetStore((s) => s.customPresets);
  const addPreset = usePresetStore((s) => s.addPreset);
  const [draft, setDraft] = useState<Draft>(() => draftFromPreset(effectivePreset(item, customPresets)));

  // Esc 关闭（背景点击见 overlay onClick）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const onContainerChange = (container: Container) => {
    // mp3/wav 是纯音频容器：视频段强制关闭
    patch(container === "mp4" ? { container } : { container, videoEnabled: false });
  };

  const settings = draftToSettings(draft);
  const applyDisabled = settings === null;
  const saveDisabled = applyDisabled || draft.presetName.trim() === "";

  /**
   * 重投该项（waiting 项 remove→add）：换预设或挂 override 后输出路径按新设置定稿。
   * 队列 store 无「原地改项」动作，重投是其等价实现（代价：项移到队尾，见文件头说明）。
   */
  const reEnqueue = (
    presetId: string,
    presetLabel: string,
    container: Container,
    override?: PresetOverride,
  ) => {
    const { defaultOutputDir } = usePresetStore.getState();
    const queue = useQueueStore.getState();
    queue.remove(item.id);
    queue.add([
      {
        path: item.path,
        mediaInfo: item.mediaInfo,
        presetId,
        presetLabel,
        outDir: defaultOutputDir || dirnameOf(item.path),
        ext: container,
        override,
      },
    ]);
  };

  const applyOverride = () => {
    if (!settings) return;
    // override 只带数据段（container/video/audio），runner {...preset, ...override} 合并；
    // 名字留基预设的（队列表显示「自定义（基于 X）」）
    reEnqueue(
      item.presetId,
      effectivePreset(item, customPresets).name,
      settings.container,
      {
        container: settings.container,
        video: settings.video,
        audio: settings.audio,
      },
    );
    onClose();
  };

  const saveAsPresetAndApply = () => {
    if (!settings) return;
    const created = addPreset({
      name: draft.presetName.trim(),
      category: settings.video ? "视频" : "音频",
      container: settings.container,
      video: settings.video,
      audio: settings.audio,
    });
    reEnqueue(created.id, created.name, created.container);
    onClose();
  };

  const audioCodec = AUDIO_CODEC_FOR_CONTAINER[draft.container];

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal-card export-settings"
        role="dialog"
        aria-modal="true"
        aria-label="导出设置"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-card__header">
          <span className="modal-card__title">导出设置 — {basenameOf(item.path)}</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={15} aria-hidden />
          </button>
        </header>

        <div className="modal-card__body export-settings__body">
          <fieldset className="export-settings__group">
            <legend>格式</legend>
            <label className="form-row">
              <span className="form-row__label">容器</span>
              <select
                value={draft.container}
                onChange={(e) => onContainerChange(e.target.value as Container)}
              >
                <option value="mp4">MP4（视频 / 纯音频 AAC）</option>
                <option value="mp3">MP3（纯音频）</option>
                <option value="wav">WAV（纯音频无损）</option>
              </select>
            </label>
          </fieldset>

          {draft.container === "mp4" && (
            <fieldset className="export-settings__group">
              <legend>
                <label className="export-settings__legend-check">
                  <input
                    type="checkbox"
                    checked={draft.videoEnabled}
                    onChange={(e) => patch({ videoEnabled: e.target.checked })}
                  />
                  视频
                </label>
              </legend>
              {draft.videoEnabled && (
                <>
                  <label className="form-row">
                    <span className="form-row__label">编解码器</span>
                    <select
                      value={draft.videoCodec}
                      onChange={(e) => patch({ videoCodec: e.target.value as VideoCodec })}
                    >
                      <option value="libx264">H.264（libx264）</option>
                      <option value="libx265">H.265（libx265）</option>
                    </select>
                  </label>
                  <label className="form-row">
                    <span className="form-row__label">码率控制</span>
                    <select
                      value={draft.rateMode}
                      onChange={(e) => patch({ rateMode: e.target.value as VideoRateControl["mode"] })}
                    >
                      <option value="bitrate">平均码率封顶</option>
                      <option value="crf">恒定质量 CRF</option>
                    </select>
                    {draft.rateMode === "bitrate" ? (
                      <span className="form-row__inline">
                        <input
                          type="number"
                          min={64}
                          max={200000}
                          step={100}
                          value={draft.bitrateKbps}
                          onChange={(e) => patch({ bitrateKbps: e.target.value })}
                          aria-label="视频码率 kbps"
                        />
                        <span className="form-row__unit">kbps</span>
                      </span>
                    ) : (
                      <span className="form-row__inline">
                        <input
                          type="number"
                          min={0}
                          max={51}
                          value={draft.crf}
                          onChange={(e) => patch({ crf: e.target.value })}
                          aria-label="CRF"
                        />
                        <span className="form-row__unit">CRF（小=质量高）</span>
                      </span>
                    )}
                  </label>
                  <label className="form-row">
                    <span className="form-row__label">分辨率策略</span>
                    <select
                      value={draft.maxHeight}
                      onChange={(e) => patch({ maxHeight: e.target.value as MaxHeight })}
                    >
                      <option value="1080">最高 1080p（仅降采样）</option>
                      <option value="720">最高 720p（仅降采样）</option>
                      <option value="source">保持源分辨率</option>
                    </select>
                  </label>
                  <label className="form-row">
                    <span className="form-row__label">帧率</span>
                    <span className="form-row__inline">
                      <label className="export-settings__check">
                        <input
                          type="checkbox"
                          checked={draft.fpsFollowSource}
                          onChange={(e) => patch({ fpsFollowSource: e.target.checked })}
                        />
                        跟随源
                      </label>
                      {!draft.fpsFollowSource && (
                        <>
                          <input
                            type="number"
                            min={1}
                            max={240}
                            value={draft.fps}
                            onChange={(e) => patch({ fps: e.target.value })}
                            aria-label="输出帧率"
                          />
                          <span className="form-row__unit">fps</span>
                        </>
                      )}
                    </span>
                  </label>
                </>
              )}
            </fieldset>
          )}

          <fieldset className="export-settings__group">
            <legend>
              <label className="export-settings__legend-check">
                <input
                  type="checkbox"
                  checked={draft.audioEnabled}
                  onChange={(e) => patch({ audioEnabled: e.target.checked })}
                />
                音频
              </label>
            </legend>
            {draft.audioEnabled && (
              <>
                <label className="form-row">
                  <span className="form-row__label">编解码器</span>
                  <span className="form-row__readonly">
                    {audioCodec === "aac" ? "AAC" : audioCodec === "libmp3lame" ? "MP3" : "PCM 无损"}
                    （由容器决定）
                  </span>
                </label>
                <label className="form-row">
                  <span className="form-row__label">码率</span>
                  <span className="form-row__inline">
                    <input
                      type="number"
                      min={8}
                      max={1000}
                      step={8}
                      value={audioCodec === "pcm_s16le" ? "" : draft.audioBitrateKbps}
                      onChange={(e) => patch({ audioBitrateKbps: e.target.value })}
                      disabled={audioCodec === "pcm_s16le"}
                      aria-label="音频码率 kbps"
                    />
                    <span className="form-row__unit">
                      {audioCodec === "pcm_s16le" ? "无损，不设码率" : "kbps"}
                    </span>
                  </span>
                </label>
                <label className="form-row">
                  <span className="form-row__label">采样率</span>
                  <select value={draft.sampleRate} onChange={(e) => patch({ sampleRate: e.target.value })}>
                    <option value="44100">44.1 kHz</option>
                    <option value="48000">48 kHz</option>
                  </select>
                </label>
              </>
            )}
          </fieldset>
        </div>

        <footer className="modal-card__footer">
          <label className="export-settings__save-name">
            <span className="form-row__label">预设名</span>
            <input
              type="text"
              value={draft.presetName}
              placeholder="另存为预设的名称"
              onChange={(e) => patch({ presetName: e.target.value })}
            />
          </label>
          <div className="modal-card__actions">
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="btn"
              onClick={saveAsPresetAndApply}
              disabled={saveDisabled}
              title={saveDisabled ? (applyDisabled ? "参数不完整" : "先填预设名") : undefined}
            >
              <Save size={13} aria-hidden />
              另存为预设并应用
            </button>
            <button type="button" className="btn btn--primary" onClick={applyOverride} disabled={applyDisabled}>
              <Check size={13} aria-hidden />
              应用到此任务
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
