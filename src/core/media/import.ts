/**
 * 素材导入编排：多选对话框 / 选文件夹单层展开 / 窗口拖入 → 白名单过滤 →
 * 绝对路径去重 → 批量 probe → 产出 QueueCandidate[]（对接面：{path, mediaInfo}[]
 * 交队列 store.add，id 等由队列层补全）。
 *
 * 白名单口径（开发计划·模块4）：视频 11 种、音频 8 种可入队；图片 5 种可被识别
 * 与探测（结果附在 skipped 里供展示），但按 MVP 边界拒绝入队。gif 不在锻名单
 * （jian 有——按锻规格清单执行，属有意差异）。
 * 副作用入口（dialog/fs/webview）集中在本 core 层，UI 只消费 importFrom* / onDropImport；
 * dialog/fs 插件包集成期才安装，故相关依赖在函数体内动态 import（测试期整段不触达）。
 */
import type { MediaInfo } from "./probe";
import { probeMedia } from "./probe";

/** 可入队视频扩展名（小写、无点）。 */
export const VIDEO_EXTENSIONS = [
  "mp4", "mov", "mkv", "avi", "webm", "m4v", "mpg", "mpeg", "ts", "flv", "wmv",
] as const;

/** 可入队音频扩展名。 */
export const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "aac", "m4a", "ogg", "opus"] as const;

/** 图片扩展名：可识别、可探测（供展示），但 MVP 不做图片转码、拒绝入队。 */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp"] as const;

/** 全部认识的白名单（含图片）。 */
const ALLOWED_EXTENSIONS = new Set<string>([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS]);

/** 导入对话框过滤器（plugin-dialog：扩展名不带点）。 */
export const IMPORT_FILTERS = [
  { name: "全部支持的媒体", extensions: [...ALLOWED_EXTENSIONS] },
  { name: "视频", extensions: [...VIDEO_EXTENSIONS] },
  { name: "音频", extensions: [...AUDIO_EXTENSIONS] },
  { name: "图片（仅探测展示，不入队）", extensions: [...IMAGE_EXTENSIONS] },
];

/** 队列候选：导入产出的最小形状，交队列 store.add。 */
export interface QueueCandidate {
  path: string;
  mediaInfo: MediaInfo;
}

/** 被挡在队列外的路径与原因（UI 可据此提示「已忽略 N 项」）。 */
export interface SkippedItem {
  path: string;
  reason: "unsupported" | "image-not-supported" | "probe-failed";
  /** probe 失败时 Rust 带回的错误文案。 */
  error?: string;
  /** 图片项探测成功时的元数据（「供探测展示」的数据落点）。 */
  mediaInfo?: MediaInfo;
}

/** 一次导入的结果：候选 + 被跳过明细。 */
export interface ImportOutcome {
  candidates: QueueCandidate[];
  skipped: SkippedItem[];
}

/** 取小写扩展名（无点）；无扩展名 / 隐藏文件（.gitignore）/ 点结尾返回空串。 */
export function extensionOf(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** 白名单判定：扩展名 ∈ 视频∪音频∪图片（图片入队前还会被分拣拦下）。 */
export function isAllowedPath(path: string): boolean {
  return ALLOWED_EXTENSIONS.has(extensionOf(path));
}

/** 去重键：分隔符统一为 /、去尾斜杠、大小写不敏感（Windows 文件系统语义）。 */
export function pathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 按绝对路径去重（键见 pathKey），保首见顺序；existing 为队列已有路径。 */
export function dedupePaths(paths: string[], existing: string[] = []): string[] {
  const seen = new Set(existing.map(pathKey));
  const out: string[] = [];
  for (const p of paths) {
    const key = pathKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** plugin-fs readDir 返回的目录条目形状（只消费 name/isDirectory，结构兼容即可）。 */
export interface FolderEntry {
  name: string;
  isDirectory: boolean;
}

/** 目录条目 → 单层文件绝对路径（纯函数）：只取非目录条目，子目录不递归。
 * 产出统一正斜杠形态（Windows 下 ffmpeg/ffprobe 与后续 pathKey 去重都按此口径）。 */
export function expandEntriesToPaths(dir: string, entries: readonly FolderEntry[]): string[] {
  const base = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  return entries.filter((e) => !e.isDirectory).map((e) => `${base}/${e.name}`);
}

/**
 * 读目录做单层展开。返回 null＝不是目录/不存在/无权限（readDir 均 reject，
 * 此处不区分——区分需要 stat 权限，MVP 不引入）。
 */
export async function expandFolder(path: string): Promise<string[] | null> {
  try {
    const { readDir } = await import("@tauri-apps/plugin-fs");
    const entries = await readDir(path); // 默认 recursive=false，即单层
    return expandEntriesToPaths(path, entries);
  } catch {
    return null;
  }
}

/**
 * 导入编排入口（拖入/文件对话框/文件夹对话框三路共用）：
 * 白名单文件直接收；非白名单路径尝试当目录单层展开（拖文件夹/选文件夹场景），
 * 打不开的按 unsupported 上报；去重后逐个 probe 分拣（图片拒入队、失败跳过
 * 不拖垮整批——jian importAssets 同策略），产出队列候选。
 */
export async function importPaths(paths: string[], existingPaths: string[] = []): Promise<ImportOutcome> {
  const filePaths: string[] = [];
  const unknownPaths: string[] = [];
  for (const p of paths) {
    (isAllowedPath(p) ? filePaths : unknownPaths).push(p);
  }
  const skipped: SkippedItem[] = [];
  const folderFiles: string[] = [];
  for (const p of unknownPaths) {
    const children = await expandFolder(p);
    if (children === null) {
      skipped.push({ path: p, reason: "unsupported" });
      continue;
    }
    // 目录内的非白名单文件不逐条上报（噪音大），白名单过滤后与手选文件合并去重
    folderFiles.push(...children.filter(isAllowedPath));
  }
  const files = dedupePaths([...filePaths, ...folderFiles], existingPaths);

  // 并发探测（ffprobe 轻量，全并发与 jian importAssets 同策略）
  const probed = await Promise.allSettled(files.map((path) => probeMedia(path)));
  const candidates: QueueCandidate[] = [];
  probed.forEach((result, index) => {
    const path = files[index];
    if (result.status === "rejected") {
      console.warn(`素材探测失败，已跳过：${path}`, result.reason);
      skipped.push({ path, reason: "probe-failed", error: String(result.reason ?? "探测失败") });
      return;
    }
    const mediaInfo = result.value;
    if (mediaInfo.kind === "image") {
      // MVP 边界：图片只探测展示，不入转码队列
      skipped.push({ path, reason: "image-not-supported", mediaInfo });
      return;
    }
    candidates.push({ path, mediaInfo });
  });
  return { candidates, skipped };
}

/** 多选文件对话框导入；用户取消返回空结果（不弹错）。 */
export async function importFromDialog(existingPaths: string[] = []): Promise<ImportOutcome> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: true,
    directory: false,
    filters: IMPORT_FILTERS,
  });
  // plugin-dialog 多选返回 string[]；单个返回 string；取消为 null
  const paths = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
  if (paths.length === 0) return { candidates: [], skipped: [] };
  return importPaths(paths, existingPaths);
}

/** 选文件夹导入：其下文件单层展开（不递归）；取消返回空结果。 */
export async function importFromFolderDialog(existingPaths: string[] = []): Promise<ImportOutcome> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ multiple: false, directory: true });
  if (typeof selected !== "string") return { candidates: [], skipped: [] };
  return importPaths([selected], existingPaths);
}

/**
 * 窗口拖入订阅（产品分析「拖入素材」交互）：drop 事件的 paths 交给回调，
 * 由 UI 调 importPaths 完成探测入队；enter/over/leave 不理会。
 * 返回 unlisten，AppShell 挂载时订阅、卸载时反订阅。
 */
export async function onDropImport(handler: (paths: string[]) => void): Promise<() => void> {
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") handler(event.payload.paths);
  });
}
