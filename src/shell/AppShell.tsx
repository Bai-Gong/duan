import { useState } from "react";
import { DockHost, ThemeProvider } from "@baigong/fang";
import "@baigong/fang/tokens.css";
import { TopBar } from "./TopBar";
import { PresetBrowserPanel } from "../features/preset-browser/PresetBrowserPanel";
import { QueueTablePanel } from "../features/queue-table/QueueTablePanel";
import { EncodingPanel } from "../features/encoding-panel/EncodingPanel";
import { PreviewMonitor } from "../features/preview/PreviewMonitor";
import { FALLBACK_PRESET } from "../features/queue-table/QueueTablePanel";

/**
 * 应用外壳：TopBar + 三列停靠（fang DockHost），产品分析四区接线（M2 完成态）：
 * 左＝预设浏览器，中＝编码队列表，右＝正在编码；点队列项弹预览监视器。
 *
 * 「当前预设」是队列会话 UI 态：core 两个 store（preset/queue）都没有也不该有
 * 该字段（预设 store 只管数据、队列 store 不反向依赖预设域），故由本外壳持有、
 * props 下发预设浏览器（写）与队列表（读：入队套用）。初始值取内置 H.264 1080p，
 * 保证首次导入即有可用预设。
 */
export function AppShell() {
  const [currentPresetId, setCurrentPresetId] = useState<string>(FALLBACK_PRESET.id);
  const [previewItemId, setPreviewItemId] = useState<string | null>(null);

  return (
    <ThemeProvider>
      <div className="app-shell">
        <TopBar />
        <DockHost
          sideWidth={300}
          left={<PresetBrowserPanel currentPresetId={currentPresetId} onSelectPreset={setCurrentPresetId} />}
          center={<QueueTablePanel currentPresetId={currentPresetId} onOpenPreview={setPreviewItemId} />}
          right={<EncodingPanel onOpenPreview={setPreviewItemId} />}
        />
        {previewItemId !== null && (
          <PreviewMonitor itemId={previewItemId} onClose={() => setPreviewItemId(null)} />
        )}
      </div>
    </ThemeProvider>
  );
}
