/**
 * 顶栏：应用标识＋工具定位说明＋引擎切换＋队列控制（开始 / 停止）。
 *
 * 「开始队列」是队列引擎的接线层（runner.startQueue 的 resolvePreset/getEngine 注入点）：
 * 内置＋自建全集的构成属预设域知识，由这里用 findPreset 组装传入——
 * 队列引擎不反向依赖预设 store（core/queue/store.ts 头注释的边界约定）。
 * 点击时经 usePresetStore.getState() 取最新自建集：预设增删不触发顶栏重渲，
 * 但每次启动都解析当前全集，悬空 presetId 由 runner 落 failed 提示。
 * 引擎切换（M3 接线轨）：ffmpeg＝子进程（全格式、回退与对拍基准）；
 * ye＝进程内（H.264 解码+编码、音频直通；能力面外由 buildYeTranscodeParams
 * 在该项执行时明确报错，不静默降级）。running 中锁切换（取消命令按引擎路由）。
 */
import { Play, Square } from "lucide-react";
import { findPreset, usePresetStore } from "../core/preset/store";
import { startQueue, stopQueue } from "../core/queue/runner";
import { useQueueStore } from "../core/queue/store";

export function TopBar() {
  const running = useQueueStore((s) => s.running);
  const items = useQueueStore((s) => s.items);
  const engine = usePresetStore((s) => s.engine);
  const setEngine = usePresetStore((s) => s.setEngine);
  const waiting = items.filter((i) => i.status === "waiting").length;

  const handleStart = () => {
    void startQueue({
      resolvePreset: (id) => findPreset(usePresetStore.getState().customPresets, id),
      getEngine: () => usePresetStore.getState().engine,
    });
  };

  return (
    <header className="top-bar">
      <span className="top-bar__app">百工·锻</span>
      <span className="top-bar__divider" aria-hidden="true" />
      <span className="top-bar__sub">媒体编码 / 转码</span>

      <div className="top-bar__actions">
        <select
          className="top-bar__engine"
          value={engine}
          onChange={(e) => setEngine(e.target.value as "ffmpeg" | "ye")}
          disabled={running}
          title="转码引擎：ffmpeg＝子进程（全格式、回退与对拍基准）；ye＝进程内（冶 M3：H.264 解码+编码、音频直通，能力面外的预设会在该项执行时明确报错）"
          aria-label="转码引擎"
        >
          <option value="ffmpeg">引擎：ffmpeg</option>
          <option value="ye">引擎：ye（冶）</option>
        </select>
        {running ? (
          <button
            type="button"
            className="btn btn--sm"
            onClick={stopQueue}
            title="取消当前项并停止队列（等待中的项原地保留，可再启动）"
          >
            <Square size={13} aria-hidden />
            停止队列
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={handleStart}
            disabled={waiting === 0}
            title={waiting > 0 ? `按队列表顺序串行编码 ${waiting} 项` : "队列中没有等待中的任务"}
          >
            <Play size={13} aria-hidden />
            开始队列{waiting > 0 ? `（${waiting}）` : ""}
          </button>
        )}
      </div>
    </header>
  );
}
