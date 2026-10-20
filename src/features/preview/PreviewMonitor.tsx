/**
 * 预览监视器（点选队列项弹出，产品分析「主界面四大区」之四）：
 * 源元数据表＋代表帧（仅视频项，与正在编码面板同在 10% 处抽帧；音频项占位图）；
 * done 态给「打开文件 / 打开所在文件夹」（走 opener 插件）；failed 态展示错误尾部。
 * 完整源/输出画面对比是 MVP 边界外（开发计划·明确不做），此处只保留源信息＋产物入口。
 */
import { useEffect, useState } from "react";
import { FolderOpen, Music, X } from "lucide-react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { getFrameUrl } from "../../core/media/thumbnail";
import { useQueueStore } from "../../core/queue/store";
import type { QueueItem } from "../../core/queue/types";
import { basenameOf, STATUS_LABEL } from "../queue-table/QueueTablePanel";
import { formatDurationUs } from "../encoding-panel/EncodingPanel";
import "./preview.css";

interface PreviewMonitorProps {
  /** 要查看的队列项 id。 */
  itemId: string;
  onClose: () => void;
}

export function PreviewMonitor({ itemId, onClose }: PreviewMonitorProps) {
  const item = useQueueStore((s) => s.items.find((i) => i.id === itemId) ?? null);

  // 项被移除（预览中点了删除）→ 收弹层
  useEffect(() => {
    if (!item) onClose();
  }, [item, onClose]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!item) return null;
  return <MonitorBody item={item} onClose={onClose} />;
}

const KIND_LABEL: Record<QueueItem["mediaInfo"]["kind"], string> = {
  video: "视频",
  audio: "音频",
  image: "图片",
};

function MonitorBody({ item, onClose }: { item: QueueItem; onClose: () => void }) {
  const info = item.mediaInfo;
  const isVideo = info.kind === "video";

  // 代表帧：仅视频项抽帧（10% 处，与正在编码面板一致）；失败显示占位
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameFailed, setFrameFailed] = useState(false);
  useEffect(() => {
    setFrameUrl(null);
    setFrameFailed(false);
    if (!isVideo) return;
    let disposed = false;
    getFrameUrl(item.path, Math.max(0, Math.floor(info.durationUs * 0.1)))
      .then((url) => {
        if (!disposed) setFrameUrl(url);
      })
      .catch(() => {
        if (!disposed) setFrameFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [item.path, isVideo, info.durationUs]);

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal-card preview-monitor"
        role="dialog"
        aria-modal="true"
        aria-label={`预览监视器：${basenameOf(item.path)}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-card__header">
          <span className="modal-card__title" title={item.path}>
            预览监视器 — {basenameOf(item.path)}
          </span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={15} aria-hidden />
          </button>
        </header>

        <div className="modal-card__body preview-monitor__body">
          <div className={`preview-monitor__frame${frameFailed ? " preview-monitor__frame--failed" : ""}`}>
            {isVideo ? (
              frameUrl ? (
                <img className="preview-monitor__img" src={frameUrl} alt="代表帧（10% 处）" />
              ) : (
                <span className="preview-monitor__frame-note">
                  {frameFailed ? "取帧失败（源可播但抽帧未成）" : "取帧中…"}
                </span>
              )
            ) : (
              <span className="preview-monitor__frame-note preview-monitor__frame-note--audio">
                <Music size={26} aria-hidden />
                音频素材无画面
              </span>
            )}
          </div>

          <dl className="preview-monitor__meta">
            <dt>文件名</dt>
            <dd title={item.path}>{basenameOf(item.path)}</dd>
            <dt>路径</dt>
            <dd title={item.path}>{item.path}</dd>
            <dt>类型</dt>
            <dd>{KIND_LABEL[info.kind]}</dd>
            <dt>容器</dt>
            <dd>{info.container || "—"}</dd>
            <dt>时长</dt>
            <dd>{formatDurationUs(info.durationUs)}</dd>
            <dt>分辨率</dt>
            <dd>{info.width > 0 && info.height > 0 ? `${info.width}×${info.height}` : "—"}</dd>
            <dt>帧率</dt>
            <dd>{info.fps > 0 ? `${info.fps} fps` : "—"}</dd>
            <dt>视频编码</dt>
            <dd>{info.videoCodec || "—"}</dd>
            <dt>音频编码</dt>
            <dd>{info.audioCodec || "—"}</dd>
            <dt>音轨</dt>
            <dd>{info.hasAudio ? "有" : "无"}</dd>
            <dt>输出路径</dt>
            <dd title={item.outPath}>{item.outPath}</dd>
          </dl>

          {item.status === "failed" && item.error && (
            <div className="preview-monitor__error" role="alert">
              <p className="preview-monitor__error-title">失败原因（ffmpeg 输出尾部）：</p>
              <pre className="preview-monitor__error-body">{item.error}</pre>
            </div>
          )}
        </div>

        <footer className="modal-card__footer">
          <span className="preview-monitor__status">
            状态：<span className={`status-dot status-dot--${item.status}`} aria-hidden />
            {STATUS_LABEL[item.status]}
          </span>
          <div className="modal-card__actions">
            {item.status === "done" && (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void revealItemInDir(item.outPath)}
                >
                  <FolderOpen size={13} aria-hidden />
                  打开所在文件夹
                </button>
                <button type="button" className="btn btn--primary" onClick={() => void openPath(item.outPath)}>
                  打开文件
                </button>
              </>
            )}
            <button type="button" className="btn" onClick={onClose}>
              关闭
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
