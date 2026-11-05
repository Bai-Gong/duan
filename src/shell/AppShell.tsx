import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  AudioLines,
  Check,
  ChevronRight,
  CircleHelp,
  Film,
  FolderOpen,
  ListVideo,
  Moon,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Video,
  X,
} from "lucide-react";

type Page = "queue" | "presets";
const presets = [
  {
    name: "H.264 · 1080p",
    detail: "日常视频 · 均衡画质与体积",
    type: "视频",
    format: "MP4",
    video: "H.264",
    quality: "1080p",
    icon: Video,
  },
  {
    name: "H.264 · 720p",
    detail: "更小体积 · 便于传递与分享",
    type: "视频",
    format: "MP4",
    video: "H.264",
    quality: "720p",
    icon: Film,
  },
  {
    name: "H.264 · 原始尺寸",
    detail: "原始尺寸 · 为画面保留空间",
    type: "视频",
    format: "MP4",
    video: "H.264",
    quality: "跟随源文件",
    icon: Sparkles,
  },
  {
    name: "AAC · 音频",
    detail: "纯音频 · 收集片段中的声音",
    type: "音频",
    format: "M4A",
    video: "—",
    quality: "AAC",
    icon: AudioLines,
  },
];
const navigation = [
  { id: "queue", label: "转码队列", icon: ListVideo },
  { id: "presets", label: "预设库", icon: SlidersHorizontal },
] as const;

export function AppShell() {
  const [page, setPage] = useState<Page>("queue");
  const [dark, setDark] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("全部");
  const [selected, setSelected] = useState(0);
  const [settings, setSettings] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (settings) dialog?.showModal();
    else dialog?.close();
  }, [settings]);
  const current = presets[selected];
  return (
    <div className="app-shell" data-theme={dark ? "dark" : "light"}>
      <header className="top-bar">
        <div className="brand">
          <span className="brand-mark">锻</span>
          <strong>
            百工<span>·</span>锻
          </strong>
          <span className="brand-caption">媒体转码</span>
        </div>
        <div className="top-actions">
          <span className="preview-badge">界面预览</span>
          <button
            className="icon-button"
            aria-label={dark ? "切换浅色主题" : "切换深色主题"}
            onClick={() => setDark(!dark)}
          >
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button
            className="icon-button"
            aria-label="界面说明"
            onClick={() => setSettings(true)}
          >
            <CircleHelp size={18} />
          </button>
        </div>
      </header>
      <div className="workspace">
        <nav className="workspace-nav" aria-label="主导航">
          <span className="nav-caption">工作区</span>
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "active" : ""}`}
              aria-current={page === id ? "page" : undefined}
              onClick={() => setPage(id)}
            >
              <Icon size={19} />
              {label}
              {id === "queue" && <span className="nav-count">0</span>}
            </button>
          ))}
          <div className="nav-bottom">
            <div className="engine-note">
              <span className="status-dot" />
              <div>
                <strong>等待冶接入</strong>
                <p>媒体功能暂未开放</p>
              </div>
            </div>
            <button className="nav-item" onClick={() => setSettings(true)}>
              <Settings2 size={18} />
              界面设置
            </button>
            <span className="version">百工创作工具集 · 0.1</span>
          </div>
        </nav>
        <main className="main-content">
          <div className="breadcrumb">
            工作区 <ChevronRight size={13} />{" "}
            {navigation.find((n) => n.id === page)?.label}
          </div>
          {page === "queue" ? (
            <>
              <div className="page-heading">
                <div>
                  <h1>转码队列</h1>
                  <p>集中查看素材、输出预设与任务状态。</p>
                </div>
                <button className="primary-button" disabled>
                  <FolderOpen size={17} />
                  添加素材
                </button>
              </div>
              <section className="queue-panel glass">
                <div className="queue-toolbar">
                  <strong>
                    全部任务 <span className="count">0</span>
                  </strong>
                  <span>等待媒体处理开放</span>
                </div>
                <div className="table-head">
                  <span>素材名称</span>
                  <span>输出预设</span>
                  <span>状态</span>
                </div>
                <div className="empty-state">
                  <div className="empty-icon">
                    <ListVideo size={34} />
                  </div>
                  <h2>暂无任务</h2>
                  <p>等待冶接入后开放素材导入与转码。</p>
                  <span className="preview-badge">
                    当前不创建或执行转码任务
                  </span>
                </div>
                <div className="queue-footer">
                  <span>0 个任务 · 尚未开始</span>
                  <button className="primary-button" disabled>
                    开始队列
                    <ArrowRight size={15} />
                  </button>
                </div>
              </section>
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <h1>预设库</h1>
                  <p>浏览预设与输出参数。</p>
                </div>
                <span className="preview-badge">规划预设 · 尚不可执行</span>
              </div>
              <div className="preset-tools">
                <div className="filter-tabs" aria-label="预设分类">
                  {["全部", "视频", "音频"].map((f) => (
                    <button
                      key={f}
                      aria-pressed={filter === f}
                      className={filter === f ? "selected" : ""}
                      onClick={() => setFilter(f)}
                    >
                      {f}
                    </button>
                  ))}
                </div>
                <label className="search">
                  <Search size={17} />
                  <input
                    aria-label="搜索预设"
                    placeholder="搜索预设"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              </div>
              <div className="preset-grid">
                {presets.map(
                  (preset, i) =>
                    (filter === "全部" || preset.type === filter) &&
                    `${preset.name}${preset.detail}`.includes(query.trim()) && (
                      <button
                        key={preset.name}
                        className={`preset-card glass ${selected === i ? "chosen" : ""}`}
                        aria-pressed={selected === i}
                        onClick={() => setSelected(i)}
                      >
                        <div className="preset-card-top">
                          <preset.icon size={25} />
                          {selected === i ? (
                            <Check size={17} />
                          ) : (
                            <span>{preset.type}</span>
                          )}
                        </div>
                        <h2>{preset.name}</h2>
                        <p>{preset.detail}</p>
                        <div className="preset-tags">
                          <span>{preset.format}</span>
                          <span>{preset.quality}</span>
                        </div>
                      </button>
                    ),
                )}
              </div>
              {!presets.some(
                (p) =>
                  (filter === "全部" || p.type === filter) &&
                  `${p.name}${p.detail}`.includes(query.trim()),
              ) && (
                <div className="empty-state glass">
                  <Search size={28} />
                  <h2>没有匹配的预设</h2>
                  <p>试试其他关键词，或切换分类。</p>
                </div>
              )}
              <p className="footnote">
                这些预设用于界面规划，最终可用格式与参数以冶接入后的能力为准。
              </p>
            </>
          )}
        </main>
        <aside className="inspector glass">
          <div className="inspector-title">
            <SlidersHorizontal size={17} />
            <strong>{page === "presets" ? "预设详情" : "输出概览"}</strong>
          </div>
          <div className="inspector-symbol">
            <current.icon size={29} />
          </div>
          <h2>{current.name}</h2>
          <p className="inspector-description">{current.detail}</p>
          <span className="preview-badge">规划中</span>
          <div className="detail-section">
            <h3>输出格式</h3>
            <dl>
              <div>
                <dt>容器</dt>
                <dd>{current.format}</dd>
              </div>
              <div>
                <dt>视频编码</dt>
                <dd>{current.video}</dd>
              </div>
              <div>
                <dt>{current.type === "视频" ? "画面尺寸" : "音频编码"}</dt>
                <dd>{current.quality}</dd>
              </div>
            </dl>
          </div>
          <div className="detail-section">
            <h3>保存位置</h3>
            <div className="output-folder">
              <FolderOpen size={17} />
              <span>尚未设置</span>
            </div>
            <p>导入与输出开放后设置保存目录。</p>
          </div>
          <div className="inspector-bottom">
            <span className="status-dot" />
            <p>
              当前版本
              <br />
              <strong>基础界面预览</strong>
            </p>
          </div>
        </aside>
      </div>
      <footer className="status-bar">
        <span>
          <span className="status-dot" />
          界面预览 · 不处理文件
        </span>
        <span>百工·锻 0.1</span>
      </footer>
      <dialog
        ref={dialogRef}
        className="settings-dialog glass"
        aria-labelledby="settings-title"
        onCancel={() => setSettings(false)}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            const rect = e.currentTarget.getBoundingClientRect();
            if (
              e.clientX < rect.left ||
              e.clientX > rect.right ||
              e.clientY < rect.top ||
              e.clientY > rect.bottom
            )
              setSettings(false);
          }
        }}
      >
        <div className="section-heading">
          <h2 id="settings-title">界面设置</h2>
          <button
            autoFocus
            className="icon-button"
            aria-label="关闭设置"
            onClick={() => setSettings(false)}
          >
            <X size={18} />
          </button>
        </div>
        <p>设置界面外观。</p>
        <button className="theme-option" onClick={() => setDark(!dark)}>
          {dark ? <Moon size={20} /> : <Sun size={20} />}当前为
          {dark ? "深色" : "浅色"}外观
          <span>
            切换主题
            <ArrowRight size={15} />
          </span>
        </button>
        <div className="settings-note">
          <strong>本轮：基础界面</strong>
          <p>
            可切换页面、浏览与筛选规划预设。素材导入、媒体预览、转码和文件保存尚未开放，等待冶开发完成后接入。
          </p>
        </div>
      </dialog>
    </div>
  );
}
