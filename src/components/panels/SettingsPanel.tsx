import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Save,
  RotateCcw,
  Server,
  Github,
  ExternalLink,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Info,
  FolderOpen,
  HardDrive,
  ListChecks,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToastStore } from "@/stores/toastStore";
import { useModelListStore } from "@/services/modelListService";
import { Select } from "@/components/ui/Select";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useModal, getModalAnimationClasses } from "@/hooks/useModal";
import type { AppSettings } from "@/types";
import {
  checkForUpdates,
  getCurrentVersion,
  GITHUB_REPO,
  PROJECT_INFO,
  type UpdateInfo,
} from "@/services/updateService";
import {
  getStorageConfig,
  setStorageConfig,
  migrateImagesStorage,
  type StorageConfigInfo,
} from "@/services/fileStorageService";
import { rewriteStoredImagePaths } from "@/utils/imagePathRewrite";

// 更新按钮状态类型
type UpdateButtonState = "idle" | "checking" | "latest" | "hasUpdate" | "error";

// 模型可见性分组：image = 生图节点，llm = LLM 节点
type ModelVisibilityCategory = "image" | "llm";

const MODEL_CATEGORY_META: { key: ModelVisibilityCategory; label: string; hint: string }[] = [
  { key: "image", label: "生图模型", hint: "绘图生成节点可选" },
  { key: "llm", label: "LLM 模型", hint: "LLM 内容生成节点可选" },
];

/**
 * 模型管理：勾选各节点类型可使用的模型。
 * 数据来源 = 所有供应商实时模型列表的并集（进设置页时按 TTL 缓存拉取）；
 * 黑名单语义——勾选=展示，取消勾选=从对应节点的模型选择器中隐藏。
 */
function ModelVisibilitySection() {
  const providers = useSettingsStore((s) => s.settings.providers);
  const disabledModels = useSettingsStore((s) => s.settings.disabledModels);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const fetchModels = useModelListStore((s) => s.fetchModels);
  const entries = useModelListStore((s) => s.entries);

  const safeDisabled = disabledModels ?? { image: [], llm: [] };

  useEffect(() => {
    for (const p of providers) {
      void fetchModels(p);
    }
  }, [providers, fetchModels]);

  // 所有供应商模型并集（按 id 去重，保留首个 label）
  const allModels = (() => {
    const byId = new Map<string, string | undefined>();
    for (const p of providers) {
      for (const m of entries[p.id]?.models ?? []) {
        if (!byId.has(m.id)) byId.set(m.id, m.label);
      }
    }
    return [...byId.entries()].map(([id, label]) => ({ id, label }));
  })();

  const isLoading = providers.some((p) => entries[p.id]?.loading);
  const loadError = providers.length > 0 ? entries[providers[0].id]?.error : undefined;

  const toggleModel = (category: ModelVisibilityCategory, modelId: string) => {
    const current = safeDisabled[category];
    const next = current.includes(modelId)
      ? current.filter((id) => id !== modelId)
      : [...current, modelId];
    updateSettings({ disabledModels: { ...safeDisabled, [category]: next } });
  };

  const renderGroup = (category: ModelVisibilityCategory) => {
    const hidden = safeDisabled[category];
    return (
      <div className="nc-soft-panel space-y-1.5">
        {allModels.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs text-base-content/45">
            {providers.length === 0
              ? "请先添加供应商"
              : isLoading
                ? "正在获取模型列表..."
                : loadError
                  ? `模型列表获取失败：${loadError}`
                  : "供应商暂未返回模型列表"}
          </div>
        ) : (
          allModels.map(({ id, label }) => {
            const enabled = !hidden.includes(id);
            return (
              <label
                key={id}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-base-200/50"
              >
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm checkbox-primary"
                  checked={enabled}
                  onChange={() => toggleModel(category, id)}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{label ?? id}</span>
                {label && label !== id && (
                  <span className="min-w-0 truncate text-[11px] text-base-content/40">{id}</span>
                )}
              </label>
            );
          })
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <ListChecks className="w-4 h-4 text-base-content/70" />
        <span className="nc-section-title">模型管理</span>
      </div>
      <p className="text-xs text-base-content/50">
        勾选各节点类型可以使用的模型（数据来自供应商实时列表）；取消勾选后模型不再出现在对应节点的选择器中，随时可以勾回来。
      </p>
      <div className="space-y-3">
        {MODEL_CATEGORY_META.map(({ key, label, hint }) => (
          <div key={key} className="space-y-1.5">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium">{label}</span>
              <span className="text-[11px] text-base-content/40">{hint}</span>
            </div>
            {renderGroup(key)}
          </div>
        ))}
      </div>
    </div>
  );
}

// 图片存储位置设置区块
function StorageLocationSection() {
  const [storageInfo, setStorageInfo] = useState<StorageConfigInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // 待确认的目录变更：from → target
  const [pendingChange, setPendingChange] = useState<{ from: string; target: string; isReset: boolean } | null>(null);

  const reload = async (): Promise<StorageConfigInfo | null> => {
    try {
      const info = await getStorageConfig();
      setStorageInfo(info);
      return info;
    } catch (e) {
      console.error("[Settings] 读取存储配置失败:", e);
      return null;
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const pickFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: "选择图片存储目录" });
      if (typeof dir !== "string" || !dir) return;
      // storageInfo 尚未加载时先读取一次，避免所选目录被静默丢弃
      let info = storageInfo;
      if (!info) {
        info = await reload();
      }
      if (info) {
        setPendingChange({ from: info.images_dir, target: dir, isReset: false });
      }
    } catch (e) {
      console.error("[Settings] 选择目录失败:", e);
      useToastStore.getState().error("选择目录失败");
    }
  };

  const handleReset = () => {
    if (!storageInfo) return;
    setPendingChange({ from: storageInfo.images_dir, target: storageInfo.default_dir, isReset: true });
  };

  const applyChange = async (migrate: boolean) => {
    if (!pendingChange) return;
    const { from, target, isReset } = pendingChange;
    setBusy(true);
    try {
      if (isReset) {
        // 恢复默认：写回 null 归一化，避免 default_dir 作为"自定义目录"留在配置里
        if (migrate) {
          const result = await migrateImagesStorage(target);
          rewriteStoredImagePaths(from, target);
          await setStorageConfig(null);
          useToastStore
            .getState()
            .success(
              result.failed_files > 0
                ? `已迁移 ${result.moved_files} 张图片，${result.failed_files} 个失败`
                : `已迁移 ${result.moved_files} 张图片到默认目录`
            );
        } else {
          await setStorageConfig(null);
          useToastStore.getState().success("已恢复默认存储目录，旧图片保留在原位置");
        }
      } else if (migrate) {
        const result = await migrateImagesStorage(target);
        rewriteStoredImagePaths(from, target);
        useToastStore
          .getState()
          .success(
            result.failed_files > 0
              ? `已迁移 ${result.moved_files} 张图片，${result.failed_files} 个失败`
              : `已迁移 ${result.moved_files} 张图片到新目录`
          );
      } else {
        await setStorageConfig(target);
        useToastStore
          .getState()
          .success(
            "存储目录已更新，已有图片保留在原位置。画廊与新生成的图片将使用新目录（旧图片保留在原位置）。"
          );
      }
      await reload();
    } catch (e) {
      console.error("[Settings] 更新存储目录失败:", e);
      useToastStore.getState().error(`更新存储目录失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setPendingChange(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <HardDrive className="w-4 h-4 text-base-content/70" />
        <span className="nc-section-title">图片存储位置</span>
      </div>

      <div className="nc-soft-panel space-y-3">
        <div>
          <div className="nc-field-label">当前目录{storageInfo?.is_custom ? "（自定义）" : "（默认）"}</div>
          <div className="text-sm break-all font-mono bg-base-100 rounded-lg px-3 py-2 border border-base-300">
            {storageInfo?.images_dir || "读取中..."}
          </div>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-outline btn-sm flex-1 gap-2" onClick={pickFolder} disabled={busy}>
            <FolderOpen className="w-4 h-4" />
            更改目录
          </button>
          {storageInfo?.is_custom && (
            <button className="btn btn-ghost btn-sm gap-2" onClick={handleReset} disabled={busy}>
              <RotateCcw className="w-4 h-4" />
              恢复默认
            </button>
          )}
        </div>
        <p className="text-xs text-base-content/50">
          新生成的图片将保存到所选目录；更改时可以选择是否迁移已有图片。
        </p>
      </div>

      {/* 迁移确认对话框 */}
      {pendingChange && (
        <div className="nc-modal-backdrop nc-modal-backdrop-nested nc-modal-backdrop-open">
          <div className="nc-modal nc-modal-sm mx-4">
            <div className="nc-modal-header">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-info/10 rounded-lg">
                  <FolderOpen className="w-5 h-5 text-info" />
                </div>
                <h3 className="nc-modal-title">{pendingChange.isReset ? "恢复默认存储目录" : "更改存储目录"}</h3>
              </div>
            </div>
            <div className="nc-modal-body">
              <p className="text-sm text-base-content/70 mb-1">是否同时把已有图片迁移到新目录？</p>
              <p className="text-xs text-base-content/50 mb-1 break-all">新目录：{pendingChange.target}</p>
              <p className="text-xs text-base-content/50 mb-5">不迁移则旧图片保留在原位置，画布中仍可正常显示。</p>
              <div className="flex flex-col gap-2">
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void applyChange(true)}>
                  {busy ? "迁移中..." : "迁移已有图片"}
                </button>
                <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => void applyChange(false)}>
                  仅更改，不迁移
                </button>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPendingChange(null)}>
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsPanel() {
  const {
    settings,
    isSettingsOpen,
    closeSettings,
    updateSettings,
    resetSettings,
    openProviderPanel,
  } = useSettingsStore();
  const [localTheme, setLocalTheme] = useState<AppSettings["theme"]>(
    settings.theme
  );
  const [updateButtonState, setUpdateButtonState] =
    useState<UpdateButtonState>("idle");
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  // 重置确认对话框
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // 使用统一的 modal hook
  const { isVisible, isClosing, handleClose, handleBackdropClick } = useModal({
    isOpen: isSettingsOpen,
    onClose: closeSettings,
  });

  // 获取动画类名
  const { contentClasses } = getModalAnimationClasses(isVisible, isClosing);

  if (!isSettingsOpen) return null;

  const handleSave = () => {
    updateSettings({ theme: localTheme });
    closeSettings();
  };

  const handleReset = () => {
    resetSettings();
    setLocalTheme(useSettingsStore.getState().settings.theme);
    setShowResetConfirm(false);
  };

  const handleOpenProviders = () => {
    closeSettings();
    openProviderPanel();
  };

  const handleCheckUpdate = async () => {
    setUpdateButtonState("checking");
    setUpdateInfo(null);

    try {
      const info = await checkForUpdates();
      setUpdateInfo(info);
      setUpdateButtonState(info.hasUpdate ? "hasUpdate" : "latest");

      // 如果已是最新版本，3秒后恢复按钮状态
      if (!info.hasUpdate) {
        setTimeout(() => {
          setUpdateButtonState("idle");
        }, 3000);
      }
    } catch {
      setUpdateButtonState("error");
      // 错误状态 3 秒后恢复
      setTimeout(() => {
        setUpdateButtonState("idle");
      }, 3000);
    }
  };

  const handleOpenGitHub = async () => {
    await openUrl(GITHUB_REPO.url);
  };

  const handleOpenRelease = async () => {
    if (updateInfo?.releaseUrl) {
      await openUrl(updateInfo.releaseUrl);
    }
  };

  // 获取更新按钮的样式和内容
  const getUpdateButtonProps = () => {
    switch (updateButtonState) {
      case "checking":
        return {
          className: "btn btn-outline w-full gap-2",
          disabled: true,
          icon: <RefreshCw className="w-4 h-4 animate-spin" />,
          text: "正在检测...",
        };
      case "latest":
        return {
          className: "btn btn-success w-full gap-2",
          disabled: false,
          icon: <CheckCircle className="w-4 h-4" />,
          text: "已是最新版本",
        };
      case "error":
        return {
          className: "btn btn-error btn-outline w-full gap-2",
          disabled: false,
          icon: <AlertCircle className="w-4 h-4" />,
          text: "检测失败",
        };
      default:
        return {
          className: "btn btn-outline w-full gap-2",
          disabled: false,
          icon: <RefreshCw className="w-4 h-4" />,
          text: "检测更新",
        };
    }
  };

  const updateButtonProps = getUpdateButtonProps();

  return createPortal(
    <div
      className={`nc-modal-backdrop ${isVisible && !isClosing ? "nc-modal-backdrop-open" : ""}`}
      onClick={handleBackdropClick}
    >
      {/* Modal 内容 */}
      <div
        className={`
          nc-modal nc-modal-md mx-4 max-h-[90vh] flex flex-col
          transition-all duration-200 ease-out
          ${contentClasses}
        `}
      >
        {/* 头部 */}
        <div className="nc-modal-header">
          <h2 className="nc-modal-title">设置</h2>
          <button
            className="nc-icon-btn"
            onClick={handleClose}
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 内容 */}
        <div className="nc-modal-body space-y-4">
          {/* 供应商管理入口 */}
          <div
            className="nc-soft-panel flex items-center justify-between cursor-pointer hover:bg-base-300! transition-colors"
            onClick={handleOpenProviders}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                <Server className="w-5 h-5 text-primary" />
              </div>
              <div>
                <div className="font-medium">供应商管理</div>
                <div className="text-sm text-base-content/50">
                  配置 API 供应商和节点分配
                </div>
              </div>
            </div>
            <div className="text-base-content/30">→</div>
          </div>

          {/* 分隔线 */}
          <hr className="nc-divider" />

          {/* 模型管理 */}
          <ModelVisibilitySection />

          {/* 分隔线 */}
          <hr className="nc-divider" />

          {/* 图片存储位置 */}
          <StorageLocationSection />

          {/* 分隔线 */}
          <hr className="nc-divider" />

          {/* 主题 */}
          <div className="form-control">
            <label className="nc-field-label">主题</label>
            <Select
              value={localTheme}
              options={[
                { value: "light", label: "浅色" },
                { value: "dark", label: "深色" },
                { value: "system", label: "跟随系统" },
              ]}
              onChange={(value) =>
                setLocalTheme(value as AppSettings["theme"])
              }
            />
          </div>

          {/* 分隔线 */}
          <hr className="nc-divider" />

          {/* 关于与更新 */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 text-base-content/70" />
              <span className="nc-section-title">关于</span>
            </div>

            {/* 项目信息卡片 */}
            <div className="nc-soft-panel space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-lg">
                    {PROJECT_INFO.name}
                  </span>
                  <span className="nc-badge">
                    v{getCurrentVersion()}
                  </span>
                </div>
              </div>

              <p className="text-sm text-base-content/70">
                {PROJECT_INFO.description}
              </p>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-base-content/50">
                <span>原作者: {PROJECT_INFO.upstream.author}</span>
                <span>二改维护: {PROJECT_INFO.maintainer}</span>
                <span>许可证: {PROJECT_INFO.license}</span>
              </div>
            </div>

            {/* GitHub 仓库链接 */}
            <div
              className="nc-soft-panel flex items-center justify-between cursor-pointer hover:bg-base-300! transition-colors"
              onClick={handleOpenGitHub}
            >
              <div className="flex items-center gap-3">
                <Github className="w-5 h-5" />
                <div>
                  <div className="text-sm font-medium">GitHub 仓库</div>
                  <div className="text-xs text-base-content/50">
                    {GITHUB_REPO.owner}/{GITHUB_REPO.repo}
                  </div>
                </div>
              </div>
              <ExternalLink className="w-4 h-4 text-base-content/30" />
            </div>

            {/* 检测更新按钮 */}
            <button
              className={updateButtonProps.className}
              onClick={handleCheckUpdate}
              disabled={updateButtonProps.disabled}
            >
              {updateButtonProps.icon}
              {updateButtonProps.text}
            </button>

            {/* 有新版本时显示更新信息 */}
            {updateButtonState === "hasUpdate" && updateInfo && (
              <div className="nc-warning-surface rounded-[var(--nc-radius-lg)] p-4">
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-5 h-5 text-warning" />
                    <span className="font-medium text-warning">发现新版本</span>
                  </div>
                  <div className="text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-base-content/70">当前版本:</span>
                      <span>v{updateInfo.currentVersion}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-base-content/70">最新版本:</span>
                      <span className="text-warning font-medium">
                        v{updateInfo.latestVersion}
                      </span>
                    </div>
                    {updateInfo.publishedAt && (
                      <div className="flex justify-between">
                        <span className="text-base-content/70">发布时间:</span>
                        <span>
                          {new Date(updateInfo.publishedAt).toLocaleDateString(
                            "zh-CN"
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                  <button
                    className="btn btn-warning btn-sm w-full gap-2"
                    onClick={handleOpenRelease}
                  >
                    <ExternalLink className="w-4 h-4" />
                    前往下载
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 底部 */}
        <div className="nc-modal-footer">
          <button
            className="btn btn-ghost btn-sm gap-2 mr-auto"
            onClick={() => setShowResetConfirm(true)}
          >
            <RotateCcw className="w-4 h-4" />
            重置
          </button>
          <div className="flex gap-2">
            <button className="btn btn-ghost btn-sm" onClick={handleClose}>
              取消
            </button>
            <button className="btn btn-primary btn-sm gap-2" onClick={handleSave}>
              <Save className="w-4 h-4" />
              保存
            </button>
          </div>
        </div>

        {/* 重置确认对话框 */}
        {showResetConfirm && (
          <ConfirmDialog
            tone="error"
            title="确认重置"
            message="确定要重置所有设置吗？这将清除所有供应商配置和节点分配，此操作不可撤销。"
            confirmText="确认重置"
            onConfirm={handleReset}
            onClose={() => setShowResetConfirm(false)}
          />
        )}
      </div>
    </div>,
    document.body
  );
}
