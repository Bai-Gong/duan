/**
 * 编码队列表（中区，产品分析「主界面四大区」之二）：
 * 列＝文件名/预设/输出位置/状态色标/进度条；行操作＝上移下移/跳过/取消/移除/
 * 完成后打开输出、逐项弹导出设置；导入三路（多选对话框/文件夹/窗口拖入）都落本区。
 *
 * 分层：导入编排在 core/media/import（这里组合 outcome.candidates → store.add，
 * 按当前预设补 AddQueueEntry 的 presetId/presetLabel/outDir/ext）；取消统一走
 * core/queue/runner 的 cancelJob（waiting 直落 canceled、running 走标记→kill 链路，
 * 见 runner.ts——store.cancel 只收 waiting，直调会漏 running 项）；
 * 本面板只读 store 渲染 + 调行操作，不直接 invoke（分层纪律）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { DockPanel } from "@baigong/fang";
import {
  ArrowDown,
  ArrowUp,
  FolderOpen,
  Import,
  Settings2,
  SkipForward,
  Trash2,
  X,
} from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  importFromDialog,
  importFromFolderDialog,
  importPaths,
  onDropImport,
  type ImportOutcome,
} from "../../core/media/import";
import { BUILTIN_PRESETS } from "../../core/preset/builtin";
import { findPreset, usePresetStore } from "../../core/preset/store";
import type { Preset } from "../../core/preset/types";
import { cancelJob } from "../../core/queue/runner";
import { useQueueStore } from "../../core/queue/store";
import type { QueueItem, QueueStatus } from "../../core/queue/types";
import { ExportSettingsDialog } from "../export-settings/ExportSettingsDialog";
import "./queue-table.css";

/** 状态色标文案（dot 颜色见 queue-table.css 的 status-dot--*）。 */
export const STATUS_LABEL: Record<QueueStatus, string> = {
  waiting: "等待",
  running: "编码中",
  done: "完成",
  failed: "失败",
  canceled: "已取消",
  skipped: "已跳过",
};

/** 当前预设悬空（自建被删）或未选时的兜底：内置 H.264 1080p（内置集首项保底）。 */
export const FALLBACK_PRESET: Preset =
  BUILTIN_PRESETS.find((p) => p.id === "builtin:h264-1080p-mid") ?? BUILTIN_PRESETS[0];

/** 路径 → 文件名（Windows 两种分隔符都可能出现）。 */
export function basenameOf(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

/** 路径 → 所在目录（导入路径恒为绝对路径；无分隔符时原样返回）。 */
export function dirnameOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}

/**
 * 行上生效的预设：override 段级浅合并进基预设（与 runner 的 {...preset, ...override}
 * 同语义）；基预设悬空（自建被删）时以内置兜底形状合并，保证返回完整 Preset。
 */
export function effectivePreset(item: QueueItem, customPresets: readonly Preset[]): Preset {
  const base = findPreset(customPresets, item.presetId) ?? FALLBACK_PRESET;
  return item.override ? { ...base, ...item.override } : base;
}

/** 进度百分比（0–100）：durationUs 未知（0）时返回 0，done 态置满。 */
export function percentOf(item: QueueItem): number {
  if (item.status === "done") return 100;
  const total = item.mediaInfo.durationUs;
  if (!total || total <= 0) return 0;
  const pct = Math.round((item.progressUs / total) * 100);
  return Math.max(0, Math.min(100, pct));
}

interface QueueTablePanelProps {
  /** 当前预设 id（AppShell 会话态）：入队套用；悬空/未选时落 FALLBACK_PRESET。 */
  currentPresetId: string | null;
  /** 点行打开预览监视器（AppShell 持有弹层状态）。 */
  onOpenPreview: (itemId: string) => void;
}

export function QueueTablePanel({ currentPresetId, onOpenPreview }: QueueTablePanelProps) {
  const items = useQueueStore((s) => s.items);
  const remove = useQueueStore((s) => s.remove);
  const moveUp = useQueueStore((s) => s.moveUp);
  const moveDown = useQueueStore((s) => s.moveDown);
  const skip = useQueueStore((s) => s.skip);
  const customPresets = usePresetStore((s) => s.customPresets);
  const currentPreset =
    (currentPresetId ? findPreset(customPresets, currentPresetId) : undefined) ?? FALLBACK_PRESET;

  const [importing, setImporting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [settingsItemId, setSettingsItemId] = useState<string | null>(null);

  // 拖入回调注册时闭包一次、读最新值：预设切换不反复重订 webview 事件
  const currentPresetRef = useRef(currentPreset);
  currentPresetRef.current = currentPreset;

  /** 探测结果 → 队列项（按当前预设补命名要素）＋「已忽略 N 项」提示。 */
  const enqueueOutcome = useCallback((outcome: ImportOutcome) => {
    const { candidates, skipped } = outcome;
    if (candidates.length > 0) {
      const preset = currentPresetRef.current;
      const { customPresets: customs, defaultOutputDir } = usePresetStore.getState();
      const resolved =
        (preset ? findPreset(customs, preset.id) : undefined) ?? FALLBACK_PRESET;
      // outDir 兜底：默认输出目录未设置时用源文件所在目录（naming 层不做此兜底）
      useQueueStore.getState().add(
        candidates.map((c) => ({
          path: c.path,
          mediaInfo: c.mediaInfo,
          presetId: resolved.id,
          presetLabel: resolved.name,
          outDir: defaultOutputDir || dirnameOf(c.path),
          ext: resolved.container,
        })),
      );
    }
    setNote(
      skipped.length > 0
        ? `上次导入忽略 ${skipped.length} 项（不支持格式 / 图片 / 探测失败）`
        : null,
    );
  }, []);

  const runImport = useCallback(
    async (pick: (existingPaths: string[]) => Promise<ImportOutcome>) => {
      setImporting(true);
      try {
        const existing = useQueueStore.getState().items.map((i) => i.path);
        enqueueOutcome(await pick(existing));
      } finally {
        setImporting(false);
      }
    },
    [enqueueOutcome],
  );

  // 窗口拖入 → 探测入队（订阅/反订阅归本面板，导入编排在 core）
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void onDropImport((paths) => {
      void (async () => {
        const existing = useQueueStore.getState().items.map((i) => i.path);
        enqueueOutcome(await importPaths(paths, existing));
      })();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enqueueOutcome]);

  // 设置弹层打开的项（项被移除时自动关）
  const settingsItem = settingsItemId ? (items.find((i) => i.id === settingsItemId) ?? null) : null;
  useEffect(() => {
    if (settingsItemId && !settingsItem) setSettingsItemId(null);
  }, [settingsItemId, settingsItem]);

  const doneCount = items.filter((i) => i.status === "done").length;

  return (
    <DockPanel
      title={`编码队列（${items.length}）`}
      collapsed={false}
      className="queue-table-panel"
      style={{ flex: 1, minHeight: 0 }}
    >
      <div className="queue-table">
        <div className="queue-table__toolbar">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => void runImport((existing) => importFromDialog(existing))}
            disabled={importing}
          >
            <Import size={13} aria-hidden />
            {importing ? "导入中…" : "导入素材"}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void runImport((existing) => importFromFolderDialog(existing))}
            disabled={importing}
          >
            {importing ? "读取中…" : "导入文件夹"}
          </button>
          <span
            className="queue-table__current"
            title="新任务套用的预设（在左侧预设浏览器点选更换）"
          >
            当前预设：{currentPreset.name}
          </span>
          {note && <span className="queue-table__note">{note}</span>}
          <span className="queue-table__hint">可将文件 / 文件夹拖入窗口直接入队</span>
        </div>

        {items.length === 0 ? (
          <p className="queue-table__empty">
            队列为空——点「导入素材」「导入文件夹」，或直接把音视频文件拖进窗口；
            入队后在左侧选一个预设即可开跑。
          </p>
        ) : (
          <div className="queue-table__scroll">
            <table className="queue-table__table">
              <thead>
                <tr>
                  <th>文件名</th>
                  <th>预设</th>
                  <th>输出位置</th>
                  <th>状态</th>
                  <th className="queue-table__th-progress">进度</th>
                  <th className="queue-table__th-ops">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => {
                  const basePreset = findPreset(customPresets, item.presetId);
                  const presetLabel = item.override
                    ? `自定义（基于 ${basePreset?.name ?? FALLBACK_PRESET.name}）`
                    : (basePreset?.name ?? FALLBACK_PRESET.name);
                  const pct = percentOf(item);
                  const isWaiting = item.status === "waiting";
                  // 只有等待中的项可重排/改设置（running/done 等次序与参数已定）
                  const movable = isWaiting;
                  const outPath = item.outPath;
                  return (
                    <tr
                      key={item.id}
                      className={`queue-row queue-row--${item.status}`}
                      onClick={() => onOpenPreview(item.id)}
                      title="点击查看预览监视器"
                    >
                      <td className="queue-table__name" title={item.path}>
                        {basenameOf(item.path)}
                      </td>
                      <td className="queue-table__preset">{presetLabel}</td>
                      <td className="queue-table__out" title={outPath}>
                        {basenameOf(outPath)}
                      </td>
                      <td>
                        <span className={`status-dot status-dot--${item.status}`} aria-hidden />
                        {STATUS_LABEL[item.status]}
                      </td>
                      <td>
                        <div
                          className={`qprogress${item.status === "running" ? " qprogress--running" : ""}`}
                          role="progressbar"
                          aria-valuenow={pct}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <div className="qprogress__fill" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="qprogress__label">{pct}%</span>
                      </td>
                      <td className="queue-table__ops" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="icon-btn icon-btn--sm"
                          onClick={() => moveUp(item.id)}
                          disabled={!movable || index === 0}
                          aria-label="上移"
                          title="上移"
                        >
                          <ArrowUp size={13} aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="icon-btn icon-btn--sm"
                          onClick={() => moveDown(item.id)}
                          disabled={!movable || index === items.length - 1}
                          aria-label="下移"
                          title="下移"
                        >
                          <ArrowDown size={13} aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="icon-btn icon-btn--sm"
                          onClick={() => skip(item.id)}
                          disabled={!isWaiting}
                          aria-label="跳过"
                          title="跳过"
                        >
                          <SkipForward size={13} aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="icon-btn icon-btn--sm"
                          onClick={() => setSettingsItemId(item.id)}
                          disabled={!isWaiting}
                          aria-label="导出设置"
                          title="导出设置"
                        >
                          <Settings2 size={13} aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="icon-btn icon-btn--sm"
                          onClick={() => cancelJob(item.id)}
                          disabled={item.status !== "waiting" && item.status !== "running"}
                          aria-label="取消"
                          title="取消"
                        >
                          <X size={13} aria-hidden />
                        </button>
                        {item.status === "done" && (
                          <button
                            type="button"
                            className="icon-btn icon-btn--sm"
                            onClick={() => void openPath(outPath)}
                            aria-label="打开输出文件"
                            title="打开输出文件"
                          >
                            <FolderOpen size={13} aria-hidden />
                          </button>
                        )}
                        <button
                          type="button"
                          className="icon-btn icon-btn--sm"
                          onClick={() => remove(item.id)}
                          disabled={item.status === "running"}
                          aria-label="移除"
                          title="移除"
                        >
                          <Trash2 size={13} aria-hidden />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {items.length > 0 && (
          <footer className="queue-table__footer">
            共 {items.length} 项 · 完成 {doneCount} 项
          </footer>
        )}
      </div>

      {settingsItem && (
        <ExportSettingsDialog item={settingsItem} onClose={() => setSettingsItemId(null)} />
      )}
    </DockPanel>
  );
}
