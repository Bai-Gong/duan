/**
 * 输出命名与冲突处理（纯函数：无 fs 访问、无 Rust 调用）。
 *
 * 规则（产品定位：默认输出目录 +「文件名.预设名.扩展名」，冲突自增）：
 * - 模板 {name}.{presetLabel}.{ext}：name=源文件名去扩展名，presetLabel=预设显示名，
 *   ext=预设容器扩展名（mp4/mp3/wav）；
 * - Windows 非法字符（<>:"/\|?* 与 0x00–0x1F 控制字符）逐个替换为 "_"，
 *   结尾的点/空格裁掉（资源管理器同款限制）；名字中间的点合法不清——预设名
 *   "H.264 1080p" 保持可读；
 * - 冲突自增：与已有输出集合撞名时在 presetLabel 后追加 -1/-2/…
 *   （name.label-1.ext）；比较走「分隔符归一 + 小写」——Windows 文件名
 *   不区分大小写，按 Windows 语义收口；
 * - MVP 不查磁盘同名文件（args 固定 -y 直接覆盖）：冲突集合只覆盖本会话
 *   队列内条目，磁盘级查重属队列持久化（R1）后置项。
 */

/** Windows 文件名非法字符：<>:"/\|?* 与 0x00–0x1F。 */
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
/** 名字不允许以点/空格收尾（Windows）。 */
const TRAILING_DOT_OR_SPACE = /[. ]+$/;

/** 清洗单个名字段：非法字符→下划线、结尾点/空格裁掉。 */
export function sanitizeWindowsName(name: string): string {
  return name.replace(ILLEGAL_CHARS, "_").replace(TRAILING_DOT_OR_SPACE, "");
}

/** 取路径 basename 并去掉最后一个扩展名（纯字符串处理，/ 与 \ 两种分隔符都认）。 */
export function baseNameWithoutExt(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  let base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  // 点在首位（".gitignore" 类）或没有点：整个名字就是主名
  if (dot > 0) base = base.slice(0, dot);
  return base;
}

/** 组装输出文件名：{name}.{presetLabel}.{ext}（ext 传入可带点；空段跳过）。 */
export function buildOutputFileName(sourcePath: string, presetLabel: string, ext: string): string {
  const parts = [
    sanitizeWindowsName(baseNameWithoutExt(sourcePath)),
    sanitizeWindowsName(presetLabel),
    sanitizeWindowsName(ext.trim().replace(/^\.+/, "")),
  ].filter((p) => p.length > 0);
  return parts.join(".");
}

/** 在 base（已含扩展名）的扩展名点前插入后缀："a.b.mp4" + "-1" → "a.b-1.mp4"；无扩展名则直接追加。 */
function withSuffix(base: string, suffix: string): string {
  const dot = base.lastIndexOf(".");
  return dot > 0 ? `${base.slice(0, dot)}${suffix}${base.slice(dot)}` : `${base}${suffix}`;
}

/** 路径比较键：统一分隔符 + 小写（Windows 文件名不区分大小写）。 */
function compareKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** 拼接目录与文件名（目录结尾分隔符先去掉；"D:" 盘根拼 "/" 也安全）。 */
function joinPath(dir: string, fileName: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${fileName}`;
}

/**
 * 生成不与 existing 冲突的输出绝对路径：先试 {name}.{label}.{ext}，
 * 撞名则 {name}.{label}-1.{ext}、-2、… 直到让开。
 * existing=队列内全部 outPath（含本次批量已生成的），由调用方收集。
 */
export function resolveOutputPath(
  outDir: string,
  sourcePath: string,
  presetLabel: string,
  ext: string,
  existing: Iterable<string>,
): string {
  const taken = new Set<string>();
  for (const p of existing) taken.add(compareKey(p));
  const base = buildOutputFileName(sourcePath, presetLabel, ext);
  let candidate = joinPath(outDir, base);
  if (!taken.has(compareKey(candidate))) return candidate;
  // existing 是有限集，n 递增必让开
  for (let n = 1; ; n++) {
    candidate = joinPath(outDir, withSuffix(base, `-${n}`));
    if (!taken.has(compareKey(candidate))) return candidate;
  }
}
