/**
 * 正在编码面板（右区，产品分析「主界面四大区」之三）：
 * 当前 running 项缩略图＋大号进度＋剩余估算＋队列汇总；全部完成时应用内醒目反馈
 * （系统通知是 MVP 边界外）。
 *
 * 抽帧纪律（模块规格）：仅 kind=video 且有视频流的项才调 extract_frame（经
 * core/media/thumbnail 的 getFrameUrl，10% 处抽帧＋asset URL），kind=audio 项跳过
 * 抽帧、显示音频占位图——extract_frame 对无视频流文件 ffmpeg 必非零退出返回 Err
 * （jian/ffmpeg.rs:125-145 语义），而 MP3/AAC/WAV 是内置预设，不跳过则音频任务
 * 每次报错。汇总不直接消费 selectQueueSummary：它每次调用返回新对象，直配
 * zustand v5 selector 会踩 useSyncExternalStore 快照缓存告警，这里订阅稳定的
 * items 引用后本地计数。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { DockPanel } from "@baigong/fang";
import { Film, Music } from "lucide-react";
import { getFrameUrl } from "../../core/media/thumbnail";
import { usePresetStore } from "../../core/preset/store";
import { selectRunningItem, useQueueStore } from "../../core/queue/store";
import { basenameOf, effectivePreset, percentOf } from "../queue-table/QueueTablePanel";
import "./encoding-panel.css";

/** 微秒 → mm:ss / h:mm:ss（显示用；未知时长返回 "—"）。 */
export function formatDurationUs(us: number): string {
  if (!Number.isFinite(us) || us <= 0) return "—";
  const totalSec = Math.round(us / 1_000_000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 秒 → 「≈ 3 分 20 秒」的人话剩余估算。 */
function formatEta(seconds: number): string {
  if (seconds <= 0) return "即将完成";
  if (seconds < 60) return `≈ ${Math.round(seconds)} 秒`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `≈ ${m} 分 ${s} 秒`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `≈ ${h} 时 ${m} 分`;
}

interface EncodingPanelProps {
  /** 点当前项 → 打开预览监视器（AppShell 持有弹层状态）。 */
  onOpenPreview: (itemId: string) => void;
}

export function EncodingPanel({ onOpenPreview }: EncodingPanelProps) {
  const items = useQueueStore((s) => s.items);
  const running = useQueueStore(selectRunningItem);
  const customPresets = usePresetStore((s) => s.customPresets);

  // —— 剩余估算：按 running 项 id 记起点；进度停滞时用秒级 tick 兜底刷新文案 ——
  const startedAtRef = useRef<{ id: string; at: number } | null>(null);
  const [, setTickNow] = useState(0);
  if (running && startedAtRef.current?.id !== running.id) {
    startedAtRef.current = { id: running.id, at: Date.now() };
  }
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setTickNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- 依赖项 id 而非对象

  const summary = useMemo(() => {
    const counts = { waiting: 0, running: 0, done: 0, failed: 0, canceled: 0, skipped: 0 };
    for (const item of items) counts[item.status] += 1;
    return {
      ...counts,
      total: items.length,
      finished: counts.done + counts.failed + counts.canceled + counts.skipped,
    };
  }, [items]);

  // —— 当前项缩略图：仅视频项抽帧（10% 处），音频项占位图（见文件头纪律） ——
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameFailed, setFrameFailed] = useState(false);
  useEffect(() => {
    setFrameUrl(null);
    setFrameFailed(false);
    if (!running || running.mediaInfo.kind !== "video") return;
    let disposed = false;
    const atUs = Math.max(0, Math.floor(running.mediaInfo.durationUs * 0.1));
    getFrameUrl(running.path, atUs)
      .then((url) => {
        if (!disposed) setFrameUrl(url);
      })
      .catch(() => {
        if (!disposed) setFrameFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [running?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- 抽帧只跟当前项走

  const pct = running ? percentOf(running) : 0;
  const etaText = (() => {
    if (!running || pct < 1 || !startedAtRef.current) return null;
    const elapsedSec = (Date.now() - startedAtRef.current.at) / 1000;
    return formatEta((elapsedSec / pct) * (100 - pct));
  })();

  const allFinished = summary.total > 0 && summary.finished === summary.total;

  return (
    <DockPanel
      title="正在编码"
      collapsed={false}
      className="encoding-panel"
      style={{ flex: 1, minHeight: 0 }}
    >
      <div className="encoding">
        {running ? (
          <section className="encoding__current">
            <div className={`encoding__thumb${frameFailed ? " encoding__thumb--failed" : ""}`}>
              {running.mediaInfo.kind === "video" ? (
                frameUrl ? (
                  <img className="encoding__img" src={frameUrl} alt="" />
                ) : (
                  <span className="encoding__thumb-note">
                    {frameFailed ? "取帧失败" : "取帧中…"}
                  </span>
                )
              ) : (
                <span className="encoding__thumb-note encoding__thumb-note--audio">
                  <Music size={22} aria-hidden />
                  音频任务
                </span>
              )}
              <span className="encoding__kind-badge" aria-hidden>
                <Film size={11} aria-hidden />
                {running.mediaInfo.kind === "video" ? "视频" : "音频"}
              </span>
            </div>

            <button
              type="button"
              className="encoding__name"
              onClick={() => onOpenPreview(running.id)}
              title="查看预览监视器"
            >
              {basenameOf(running.path)}
            </button>
            <div className="encoding__preset" title="该项生效的预设">
              {effectivePreset(running, customPresets).name}
              {running.override ? "（已逐项调整）" : ""}
            </div>

            <div className="encoding__big-pct">
              <span className="encoding__pct-num">{pct}</span>
              <span className="encoding__pct-unit">%</span>
            </div>
            <div
              className="encoding__bar"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="encoding__bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="encoding__times">
              <span>{formatDurationUs(running.progressUs)}</span>
              <span className="encoding__times-sep">/</span>
              <span>{formatDurationUs(running.mediaInfo.durationUs)}</span>
              {etaText && <span className="encoding__eta">剩余 {etaText}</span>}
            </div>
          </section>
        ) : allFinished ? (
          <section
            className={`encoding__banner${
              summary.failed > 0 ? " encoding__banner--mixed" : " encoding__banner--done"
            }`}
            role="status"
          >
            {summary.failed > 0
              ? `队列结束：完成 ${summary.done} 项，失败 ${summary.failed} 项`
              : `全部完成：${summary.done} 项产物已就绪`}
          </section>
        ) : summary.waiting > 0 ? (
          <p className="encoding__idle">待启动 {summary.waiting} 项——从顶栏开始队列。</p>
        ) : (
          <p className="encoding__idle">暂无编码任务。</p>
        )}

        <section className="encoding__summary">
          <h4 className="encoding__summary-title">队列汇总</h4>
          <dl className="encoding__summary-grid">
            <div>
              <dt>总计</dt>
              <dd>{summary.total}</dd>
            </div>
            <div>
              <dt>待转</dt>
              <dd>{summary.waiting}</dd>
            </div>
            <div>
              <dt>编码中</dt>
              <dd>{summary.running}</dd>
            </div>
            <div>
              <dt className="encoding__done-label">完成</dt>
              <dd className="encoding__done-label">{summary.done}</dd>
            </div>
            <div>
              <dt className="encoding__failed-label">失败</dt>
              <dd className="encoding__failed-label">{summary.failed}</dd>
            </div>
            <div>
              <dt>取消/跳过</dt>
              <dd>
                {summary.canceled}/{summary.skipped}
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </DockPanel>
  );
}
