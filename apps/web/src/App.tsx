import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Play,
  RefreshCw,
  Save,
  Send,
  ShieldAlert,
  UploadCloud
} from "lucide-react";
import type { Platform, PlatformProfile, PublishTask } from "@video-combine/shared";
import {
  createDraftTasks,
  fetchPlatforms,
  fetchTasks,
  processTask,
  retryTask,
  saveTaskDraft,
  uploadLocalFile,
  type PlatformDraftOverride
} from "./api";

const DEFAULT_PLATFORMS: Platform[] = ["youtube", "xiaohongshu", "wechat_channels"];

interface DraftState {
  title: string;
  description: string;
  tags: string;
  sourceVideoPath: string;
  coverPath: string;
}

type SubmitMode = "publish" | "save-draft";

interface ActionProgress {
  mode: SubmitMode;
  current: number;
  total: number;
  label: string;
}

const INITIAL_DRAFT: DraftState = {
  title: "今天的视频标题",
  description: "统一发布文案",
  tags: "自媒体,短视频,自动化",
  sourceVideoPath: "",
  coverPath: ""
};

export function App() {
  const [platforms, setPlatforms] = useState<PlatformProfile[]>([]);
  const [tasks, setTasks] = useState<PublishTask[]>([]);
  const [selectedPlatforms, setSelectedPlatforms] = useState<Platform[]>(DEFAULT_PLATFORMS);
  const [draft, setDraft] = useState<DraftState>(INITIAL_DRAFT);
  const [platformDrafts, setPlatformDrafts] = useState<Partial<Record<Platform, PlatformDraftOverride>>>({});
  const [activePlatform, setActivePlatform] = useState<Platform | "batch">("batch");
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionProgress, setActionProgress] = useState<ActionProgress | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    setPlatformDrafts((current) => {
      const next = { ...current };
      for (const platform of selectedPlatforms) {
        if (!next[platform]) {
          next[platform] = {};
        }
      }
      return next;
    });
  }, [selectedPlatforms]);

  const counts = tasks.reduce(
    (acc, task) => {
      acc.total += 1;
      if (task.status === "PUBLISHED") acc.published += 1;
      if (task.status === "NEED_MANUAL_ACTION" || task.status === "NEED_LOGIN") acc.manual += 1;
      if (task.status === "FAILED") acc.failed += 1;
      return acc;
    },
    { total: 0, published: 0, manual: 0, failed: 0 }
  );

  const activePlatformProfile =
    activePlatform === "batch" ? null : platforms.find((platform) => platform.id === activePlatform) ?? null;
  const activeOverride = activePlatformProfile ? platformDrafts[activePlatformProfile.id] ?? {} : {};

  async function reload() {
    const [platformList, taskList] = await Promise.all([fetchPlatforms(), fetchTasks()]);
    setPlatforms(platformList);
    setTasks(taskList);
  }

  async function submitDraft(mode: SubmitMode) {
    if (!draft.sourceVideoPath) {
      setNotice("请先选择本地视频文件");
      return;
    }

    setLoading(true);
    setNotice(null);
    setActionProgress({
      mode,
      current: 0,
      total: selectedPlatforms.length,
      label: "创建发布任务"
    });
    try {
      const created = await createDraftTasks({
        title: draft.title,
        description: draft.description,
        tags: parseTags(draft.tags),
        sourceVideoPath: draft.sourceVideoPath,
        platforms: selectedPlatforms,
        ...(draft.coverPath ? { coverPath: draft.coverPath } : {}),
        platformOverrides: selectedPlatforms.reduce<Partial<Record<Platform, PlatformDraftOverride>>>(
          (acc, platform) => {
            const override = platformDrafts[platform];
            if (!override) {
              return acc;
            }

            const nextOverride: PlatformDraftOverride = {};
            if (override.title?.trim() && override.title.trim() !== draft.title.trim()) {
              nextOverride.title = override.title.trim();
            }
            if (
              override.description?.trim() &&
              override.description.trim() !== draft.description.trim()
            ) {
              nextOverride.description = override.description.trim();
            }
            const overrideTags = override.tags ? parseTags(override.tags.join(",")) : [];
            const baseTags = parseTags(draft.tags);
            if (overrideTags.length > 0 && JSON.stringify(overrideTags) !== JSON.stringify(baseTags)) {
              nextOverride.tags = overrideTags;
            }

            if (Object.keys(nextOverride).length > 0) {
              acc[platform] = nextOverride;
            }
            return acc;
          },
          {}
        )
      });

      await reload();
      setNotice(`已创建 ${created.length} 个发布任务，开始${mode === "publish" ? "发布" : "保存草稿"}`);

      for (const [index, task] of created.entries()) {
        const platformLabel = platforms.find((platform) => platform.id === task.platform)?.label ?? task.platform;
        setActionProgress({
          mode,
          current: index + 1,
          total: created.length,
          label: `${mode === "publish" ? "发布" : "保存草稿"} ${platformLabel}`
        });
        const updatedTask =
          mode === "publish" ? await processTask(task.id) : await saveTaskDraft(task.id);
        setTasks((current) => current.map((item) => (item.id === updatedTask.id ? updatedTask : item)));
      }

      await reload();
      setNotice(mode === "publish" ? "发布流程已完成，请查看队列结果" : "平台草稿箱保存流程已完成，请查看队列结果");
    } catch (error) {
      const fallback = mode === "publish" ? "发布流程失败" : "保存平台草稿失败";
      setNotice(error instanceof Error ? error.message : fallback);
    } finally {
      setLoading(false);
      setActionProgress(null);
    }
  }

  async function retry(taskId: string) {
    setNotice(null);
    try {
      await retryTask(taskId);
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "重试失败");
    }
  }

  function togglePlatform(platform: Platform) {
    setSelectedPlatforms((current) => {
      const exists = current.includes(platform);
      const next = exists ? current.filter((item) => item !== platform) : [...current, platform];
      if (exists && activePlatform === platform) {
        setActivePlatform("batch");
      }
      return next;
    });
  }

  function updateDraftField<K extends keyof DraftState>(field: K, value: DraftState[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function updatePlatformOverride<K extends keyof PlatformDraftOverride>(
    platform: Platform,
    field: K,
    value: PlatformDraftOverride[K]
  ) {
    setPlatformDrafts((current) => ({
      ...current,
      [platform]: {
        ...current[platform],
        [field]: value
      }
    }));
  }

  function syncBatchToPlatforms() {
    setPlatformDrafts((current) => {
      const next = { ...current };
      for (const platform of selectedPlatforms) {
        next[platform] = {
          title: draft.title,
          description: draft.description,
          tags: parseTags(draft.tags)
        };
      }
      return next;
    });
    setNotice("已同步批量文案到已选平台");
  }

  function resetActivePlatformOverride(platform: Platform) {
    setPlatformDrafts((current) => ({
      ...current,
      [platform]: {
        title: draft.title,
        description: draft.description,
        tags: parseTags(draft.tags)
      }
    }));
    setNotice(`已重置 ${platforms.find((item) => item.id === platform)?.label ?? platform} 文案`);
  }

  async function handleVideoFile(file: File | undefined) {
    if (!file) {
      return;
    }
    setNotice(`正在上传视频文件: ${file.name}`);
    try {
      const uploaded = await uploadLocalFile(file, "video");
      updateDraftField("sourceVideoPath", uploaded.path);
      setNotice(`已上传视频文件: ${uploaded.originalName}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "视频上传失败");
    }
  }

  async function handleCoverFile(file: File | undefined) {
    if (!file) {
      return;
    }
    setNotice(`正在上传封面文件: ${file.name}`);
    try {
      const uploaded = await uploadLocalFile(file, "cover");
      updateDraftField("coverPath", uploaded.path);
      setNotice(`已上传封面文件: ${uploaded.originalName}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "封面上传失败");
    }
  }

  function openPlatformSite(platform: PlatformProfile) {
    window.open(platform.publishUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Private Publisher</p>
          <h1>Video Combine</h1>
        </div>
        <div className="summary-strip">
          <Metric label="任务" value={counts.total} />
          <Metric label="已发" value={counts.published} />
          <Metric label="人工" value={counts.manual} />
          <Metric label="失败" value={counts.failed} />
        </div>
      </header>

      <section className="workspace-grid">
        <form
          className="composer-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void submitDraft("publish");
          }}
        >
          <div className="section-heading">
            <UploadCloud size={20} aria-hidden="true" />
            <h2>发布草稿</h2>
          </div>

          <div className="editor-toggle" role="tablist" aria-label="编辑模式">
            <button
              className={activePlatform === "batch" ? "toggle-pill active" : "toggle-pill"}
              type="button"
              onClick={() => setActivePlatform("batch")}
            >
              批量设置表单
            </button>
            <button
              className={activePlatform !== "batch" ? "toggle-pill active" : "toggle-pill"}
              type="button"
              onClick={() => {
                const firstPlatform = selectedPlatforms[0];
                if (firstPlatform) {
                  setActivePlatform(firstPlatform);
                }
              }}
              disabled={selectedPlatforms.length === 0}
            >
              平台差异化内容
            </button>
          </div>

          <div className="composer-toolbar">
            <button className="tool-button" type="button" onClick={syncBatchToPlatforms}>
              <Copy size={16} aria-hidden="true" />
              批量同步文案
            </button>
            <span className="toolbar-hint">标题、文案、标签会同步到已选平台</span>
          </div>

          {activePlatform !== "batch" ? (
            <div className="differentiation-picker" aria-label="选择差异化平台">
              {selectedPlatforms.map((platformId) => {
                const platform = platforms.find((item) => item.id === platformId);
                return (
                  <button
                    className={activePlatform === platformId ? "mini-action active" : "mini-action"}
                    key={platformId}
                    type="button"
                    onClick={() => setActivePlatform(platformId)}
                  >
                    {platform?.label ?? platformId}
                  </button>
                );
              })}
            </div>
          ) : null}

          <label>
            标题
            <input
              value={activePlatformProfile ? activeOverride.title ?? draft.title : draft.title}
              onChange={(event) => {
                const value = event.target.value;
                if (activePlatformProfile) {
                  updatePlatformOverride(activePlatformProfile.id, "title", value);
                } else {
                  updateDraftField("title", value);
                }
              }}
            />
          </label>

          <label>
            文案
            <textarea
              value={
                activePlatformProfile ? activeOverride.description ?? draft.description : draft.description
              }
              onChange={(event) => {
                const value = event.target.value;
                if (activePlatformProfile) {
                  updatePlatformOverride(activePlatformProfile.id, "description", value);
                } else {
                  updateDraftField("description", value);
                }
              }}
            />
          </label>

          <div className="field-row">
            <label>
              标签
              <input
                value={
                  activePlatformProfile
                    ? (activeOverride.tags ?? parseTags(draft.tags)).join(",")
                    : draft.tags
                }
                onChange={(event) => {
                  const value = event.target.value;
                  if (activePlatformProfile) {
                    updatePlatformOverride(activePlatformProfile.id, "tags", parseTags(value));
                  } else {
                    updateDraftField("tags", value);
                  }
                }}
              />
            </label>
            <div className="upload-field">
              <span className="upload-label">封面文件</span>
              <button
                className="upload-button"
                type="button"
                onClick={() => coverInputRef.current?.click()}
              >
                {draft.coverPath || "点击选择本地封面"}
              </button>
              <input
                ref={coverInputRef}
                className="hidden-file-input"
                type="file"
                accept="image/*"
                onChange={(event) => void handleCoverFile(event.target.files?.[0])}
              />
            </div>
          </div>

          <div className="upload-field">
            <span className="upload-label">视频文件</span>
            <button
              className="upload-button"
              type="button"
              onClick={() => videoInputRef.current?.click()}
            >
              {draft.sourceVideoPath || "点击选择本地视频"}
            </button>
            <input
              ref={videoInputRef}
              className="hidden-file-input"
              type="file"
              accept="video/*"
              onChange={(event) => void handleVideoFile(event.target.files?.[0])}
            />
          </div>

          <div className="platform-picker" aria-label="选择平台">
            {platforms.map((platform) => (
              <div className="platform-card" key={platform.id}>
                <button
                  className={selectedPlatforms.includes(platform.id) ? "platform active" : "platform"}
                  type="button"
                  onClick={() => togglePlatform(platform.id)}
                >
                  <span>{platform.label}</span>
                  <small>{platform.publisherKind}</small>
                </button>
              </div>
            ))}
          </div>

          {activePlatformProfile ? (
            <div className="platform-editor">
              <div className="platform-editor-header">
                <div>
                  <strong>{activePlatformProfile.label}</strong>
                  <span>当前编辑的是平台独立内容，创建任务时会覆盖批量文案</span>
                </div>
                <div className="platform-editor-actions">
                  <button
                    className="mini-action"
                    type="button"
                    onClick={() => resetActivePlatformOverride(activePlatformProfile.id)}
                  >
                    用批量文案覆盖
                  </button>
                  <button
                    className="mini-action"
                    type="button"
                    onClick={() => openPlatformSite(activePlatformProfile)}
                  >
                    <ExternalLink size={14} aria-hidden="true" />
                    去平台发布页
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {actionProgress ? (
            <div className="progress-panel" aria-live="polite">
              <div className="progress-meta">
                <strong>{actionProgress.label}</strong>
                <span>
                  {actionProgress.current}/{actionProgress.total}
                </span>
              </div>
              <div className="progress-track">
                <span
                  style={{
                    width: `${Math.round((actionProgress.current / actionProgress.total) * 100)}%`
                  }}
                />
              </div>
            </div>
          ) : null}

          <div className="action-row">
            <button
              className="secondary-action"
              disabled={loading || selectedPlatforms.length === 0}
              type="button"
              onClick={() => void submitDraft("save-draft")}
            >
              <Save size={18} aria-hidden="true" />
              {loading && actionProgress?.mode === "save-draft" ? "保存中" : "保存到平台草稿箱"}
            </button>
            <button className="primary-action" disabled={loading || selectedPlatforms.length === 0}>
              <Send size={18} aria-hidden="true" />
              {loading && actionProgress?.mode === "publish" ? "发布中" : "创建并发布"}
            </button>
          </div>

          {notice ? <p className="notice">{notice}</p> : null}
        </form>

        <aside className="platform-panel">
          <div className="section-heading">
            <ShieldAlert size={20} aria-hidden="true" />
            <h2>平台接入</h2>
          </div>
          <div className="platform-table">
            {platforms.map((platform) => (
              <div className="platform-row" key={platform.id}>
                <strong>{platform.label}</strong>
                <span>{platform.publisherKind}</span>
                <em>{platform.requiresManualFallback ? "保留人工接管" : "自动发布优先"}</em>
                <button className="link-action" type="button" onClick={() => openPlatformSite(platform)}>
                  打开对应平台网页发布
                </button>
              </div>
            ))}
          </div>
        </aside>
      </section>

      <section className="queue-section">
        <div className="section-heading">
          <Play size={20} aria-hidden="true" />
          <h2>发布队列</h2>
        </div>
        <div className="task-table" role="table">
          <div className="task-head" role="row">
            <span>平台</span>
            <span>标题</span>
            <span>状态</span>
            <span>尝试</span>
            <span>结果</span>
            <span>操作</span>
          </div>
          {tasks.map((task) => {
            const platform = platforms.find((item) => item.id === task.platform);
            return (
              <div className="task-row" role="row" key={task.id}>
                <span>{platform?.label ?? task.platform}</span>
                <strong>{task.title}</strong>
                <StatusPill status={task.status} />
                <span>{task.attempt}</span>
                <span className="result-cell">{task.externalUrl ?? task.errorMessage ?? "-"}</span>
                <div className="row-actions">
                  <button
                    className="icon-button"
                    type="button"
                    title="重试任务"
                    onClick={() => void retry(task.id)}
                  >
                    <RefreshCw size={16} aria-hidden="true" />
                  </button>
                  {platform ? (
                    <button
                      className="icon-button"
                      type="button"
                      title="打开平台网页发布"
                      onClick={() => openPlatformSite(platform)}
                    >
                      <ExternalLink size={16} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
          {tasks.length === 0 ? <p className="empty-state">暂无发布任务</p> : null}
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({ status }: { status: PublishTask["status"] }) {
  const className = `status-pill ${status.toLowerCase()}`;
  return (
    <span className={className}>
      {status === "PUBLISHED" ? <CheckCircle2 size={14} aria-hidden="true" /> : null}
      {status}
    </span>
  );
}

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}
