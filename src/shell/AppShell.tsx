import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PanelDivider } from "./PanelDivider";
import { useEffect, useRef, useState, type CSSProperties } from "react";
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
  const [leftWidth, setLeftWidth] = useState(190);
  const [rightWidth, setRightWidth] = useState(260);
  const [page, setPage] = useState<Page>("queue");
  const [dark, setDark] = useState(false);
  useEffect(() => {
    if (isTauri())
      void getCurrentWindow()
        .setTheme(dark ? "dark" : "light")
        .catch(console.warn);
  }, [dark]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("全部");
  const [selected, setSelected] = useState(0);
  // Preset browsing is separate from a group's output choice.
  const [groups, setGroups] = useState([{ id: 1, name: "分组 1", preset: 0 }]);
  const [activeGroupId, setActiveGroupId] = useState(1);
  const nextGroupId = useRef(2);
  const activeGroup =
    groups.find((group) => group.id === activeGroupId) ?? groups[0];
  const updateGroup = (
    id: number,
    patch: Partial<{ name: string; preset: number }>,
  ) =>
    setGroups((previous) =>
      previous.map((group) =>
        group.id === id ? { ...group, ...patch } : group,
      ),
    );
  const addGroup = () => {
    const id = nextGroupId.current++;
    setGroups((previous) => [
      ...previous,
      { id, name: `分组 ${id}`, preset: 0 },
    ]);
    setActiveGroupId(id);
  };
  const [settings, setSettings] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (settings) dialog?.showModal();
    else dialog?.close();
  }, [settings]);
  const current = presets[page === "queue" ? activeGroup.preset : selected];
  return (
    <div className="app-shell" data-theme={dark ? "dark" : "light"}>
      <header className="top-bar" data-tauri-drag-region>
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
      <div
        className="workspace"
        style={
          {
            "--left-width": `${leftWidth}px`,
            "--right-width": `${rightWidth}px`,
          } as CSSProperties
        }
      >
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
        <PanelDivider
          side="left"
          width={leftWidth}
          min={160}
          max={300}
          initial={190}
          onResize={setLeftWidth}
        />
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
                  <p>按组整理视频，每组使用独立的输出预设。</p>
                </div>
                <button className="primary-button" onClick={addGroup}>
                  新建分组
                </button>
              </div>
              <div className="group-summary">
                <span>{groups.length} 个分组 · 0 个视频</span>
                <span>分组设置仅保留在本次会话</span>
              </div>
              <div className="group-list">
                {groups.map((group) => (
                  <section
                    key={group.id}
                    className={`queue-group glass ${activeGroupId === group.id ? "queue-group--active" : ""}`}
                    aria-label={group.name}
                  >
                    <div className="group-header">
                      <button
                        className="group-select"
                        aria-pressed={activeGroupId === group.id}
                        onClick={() => setActiveGroupId(group.id)}
                      >
                        <strong>{group.name}</strong>
                        <span>0 个视频</span>
                      </button>
                      <label className="group-preset">
                        输出预设
                        <select
                          aria-label={`${group.name}的输出预设`}
                          value={group.preset}
                          onFocus={() => setActiveGroupId(group.id)}
                          onChange={(event) => {
                            setActiveGroupId(group.id);
                            updateGroup(group.id, {
                              preset: Number(event.target.value),
                            });
                          }}
                        >
                          {presets.map((preset, index) => (
                            <option key={preset.name} value={index}>
                              {preset.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="icon-button"
                        aria-label={`移除${group.name}`}
                        disabled={groups.length === 1}
                        onClick={() => {
                          const remaining = groups.filter(
                            (item) => item.id !== group.id,
                          );
                          setGroups(remaining);
                          if (activeGroupId === group.id)
                            setActiveGroupId(remaining[0].id);
                        }}
                      >
                        <X size={16} />
                      </button>
                    </div>
                    <div className="group-empty">
                      <span>此组暂无视频</span>
                      <button className="text-button" disabled>
                        添加到此组
                      </button>
                    </div>
                    <div className="group-caption">
                      组内视频统一使用「{presets[group.preset].name}」 ·
                      素材导入尚未开放
                    </div>
                  </section>
                ))}
              </div>
              <div className="queue-footer group-footer">
                <span>0 个任务 · 尚未开始</span>
                <button className="primary-button" disabled>
                  开始全部分组
                  <ArrowRight size={15} />
                </button>
              </div>
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
        <PanelDivider
          side="right"
          width={rightWidth}
          min={220}
          max={400}
          initial={260}
          onResize={setRightWidth}
        />
        <aside className="inspector glass">
          <div className="inspector-title">
            <strong>{page === "presets" ? "预设详情" : "当前分组"}</strong>
          </div>
          {page === "queue" && (
            <div className="group-settings">
              <label>
                分组名称
                <input
                  aria-label="分组名称"
                  value={activeGroup.name}
                  maxLength={40}
                  onChange={(event) =>
                    updateGroup(activeGroup.id, { name: event.target.value })
                  }
                  onBlur={() => {
                    if (!activeGroup.name.trim())
                      updateGroup(activeGroup.id, {
                        name: `分组 ${activeGroup.id}`,
                      });
                  }}
                />
              </label>
              <p>以下设置仅作用于此组的所有视频，不影响其他分组。</p>
            </div>
          )}
          <h2>{current.name}</h2>
          <p className="inspector-description">{current.detail}</p>
          <span className="preview-badge">规划中</span>
          {page === "presets" && (
            <div className="group-settings">
              <label>
                应用到分组
                <select
                  aria-label="预设应用目标分组"
                  value={activeGroupId}
                  onChange={(event) =>
                    setActiveGroupId(Number(event.target.value))
                  }
                >
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="primary-button"
                onClick={() => {
                  updateGroup(activeGroup.id, { preset: selected });
                  setPage("queue");
                }}
              >
                应用到此组
              </button>
              <p>仅更新所选组。浏览预设不会修改其他分组。</p>
            </div>
          )}
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
            可新建、命名和移除空分组，为每组独立选择规划预设。素材导入、媒体预览、转码和文件保存尚未开放，等待冶开发完成后接入。
          </p>
        </div>
      </dialog>
    </div>
  );
}
