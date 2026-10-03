import { useState, useEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, X, Check, Trash2, Search, Plus, RefreshCw, CloudDownload, CircleAlert } from "lucide-react";
import { useModal, getModalAnimationClasses } from "@/hooks/useModal";
import { useCustomModelStore, type ModelCategory } from "@/stores/customModelStore";
import { useModelListStore, getRemoteModelLabel } from "@/services/modelListService";
import { useSettingsStore } from "@/stores/settingsStore";
import { isImageModel } from "@/config/presetModels";
import type { Provider } from "@/types";

export interface ModelOption {
  value: string;
  label: string;
}

interface ModelSelectorProps {
  value: string;
  options: ModelOption[];
  onChange: (value: string) => void;
  /** 是否允许自定义模型输入 */
  allowCustom?: boolean;
  /** 自定义模型输入的占位符 */
  customPlaceholder?: string;
  /** 按钮样式变体 */
  variant?: "primary" | "warning" | "info";
  /** 弹窗标题 */
  title?: string;
  className?: string;
  /** 模型分类，用于保存和读取用户自定义模型 */
  modelCategory?: ModelCategory;
  /** 展示方式：modal 适合画布节点，inline 适合右侧 Inspector */
  mode?: "modal" | "inline";
  /** 关联的供应商：提供时自动拉取该供应商的实时模型列表 */
  provider?: Provider | null;
}

/**
 * 模型选择器组件
 * 点击后弹出 modal 选择模型，避免画布 transform 导致的渲染问题
 */
export function ModelSelector({
  value,
  options,
  onChange,
  allowCustom = true,
  customPlaceholder = "搜索或输入模型名称",
  variant = "primary",
  title = "选择模型",
  className = "",
  modelCategory,
  mode = "modal",
  provider,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const customModels = useCustomModelStore((state) =>
    modelCategory ? state.getCustomModels(modelCategory) : []
  );
  const remoteEntry = useModelListStore((state) =>
    provider ? state.entries[provider.id] : undefined
  );
  const fetchModels = useModelListStore((state) => state.fetchModels);
  // 设置页「模型管理」勾选的黑名单：imageGenerator/llmContent 各自独立，未指定分类不过滤
  const disabledModels = useSettingsStore((state) =>
    modelCategory === "imageGenerator"
      ? state.settings.disabledModels?.image
      : modelCategory === "llmContent"
        ? state.settings.disabledModels?.llm
        : undefined
  );
  const hiddenModelSet = useMemo(() => new Set(disabledModels ?? []), [disabledModels]);

  // 打开时自动拉取实时模型列表（store 内部带 TTL 去重）
  useEffect(() => {
    if (isOpen && provider?.apiKey && provider?.baseUrl) {
      void fetchModels(provider);
    }
  }, [isOpen, provider, fetchModels]);

  // 预设与实时列表都按黑名单过滤；自定义模型不参与过滤（是用户的显式输入）
  const visibleOptions = useMemo(
    () => options.filter((opt) => !hiddenModelSet.has(opt.value)),
    [options, hiddenModelSet]
  );

  // 实时模型：按节点类别过滤（生图节点只显示图像模型，LLM 节点只显示文本模型），
  // 再排除黑名单、预设与自定义列表中的项
  const remoteOptions: ModelOption[] = provider
    ? (remoteEntry?.models || [])
        .filter((m) =>
          modelCategory === "imageGenerator"
            ? isImageModel(m.id)
            : modelCategory === "llmContent"
              ? !isImageModel(m.id)
              : true
        )
        .filter(
          (m) =>
            !hiddenModelSet.has(m.id) &&
            !options.some((opt) => opt.value === m.id) &&
            !customModels.includes(m.id)
        )
        .map((m) => ({ value: m.id, label: getRemoteModelLabel(m) }))
    : [];

  const selectedPreset =
    visibleOptions.find((opt) => opt.value === value) ||
    remoteOptions.find((opt) => opt.value === value);
  // 检查是否是自定义模型（不在预设列表中）
  const isCustomModel = Boolean(value) && !selectedPreset;
  const compactDisplayName = selectedPreset
    ? selectedPreset.label === selectedPreset.value
      ? selectedPreset.label
      : `${selectedPreset.label} (${selectedPreset.value})`
    : value || "选择模型";
  const inlineDisplayLabel = selectedPreset?.label || value || "选择模型";
  const inlineDisplayMeta = selectedPreset && selectedPreset.label !== selectedPreset.value
    ? selectedPreset.value
    : isCustomModel
      ? "自定义模型"
      : "";
  const accentTextClass = getAccentTextClass(variant);

  // 处理选择
  const handleSelect = (newValue: string) => {
    onChange(newValue);
    setIsOpen(false);
  };

  useEffect(() => {
    if (mode !== "inline" || !isOpen) return;

    const handleClickOutside = (event: globalThis.MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, mode]);

  return (
    <div
      ref={containerRef}
      className={`nc-model-selector nc-model-selector-${variant} relative ${className}`}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <label className="nc-field-label">模型</label>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className={`
          nc-model-selector-trigger w-full border text-left
          ${mode === "inline"
            ? "flex min-h-[56px] items-center justify-between gap-3 bg-base-100 px-3 py-2.5 hover:bg-base-200/35"
            : "flex items-center justify-between gap-2 bg-base-200/70 px-2 py-1.5 text-xs hover:bg-base-200"
          }
          ${isOpen ? `nc-model-selector-trigger-open nc-select-open bg-base-100` : "border-base-300/70"}
        `}
        onClick={() => setIsOpen((open) => !open)}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 flex-1 text-left">
          <span className={`block ${mode === "inline" ? "line-clamp-2 leading-5" : "truncate"} ${isCustomModel ? `${accentTextClass} font-medium` : "text-base-content"}`}>
            {mode === "inline" ? inlineDisplayLabel : compactDisplayName}
          </span>
          {mode === "inline" && inlineDisplayMeta && (
            <span className="mt-1 block break-all text-[11px] leading-4 text-base-content/45">
              {inlineDisplayMeta}
            </span>
          )}
        </span>
        <span className={`nc-model-selector-chevron-shell flex h-7 w-7 flex-shrink-0 items-center justify-center border border-base-300/70 bg-base-200/40 ${isOpen ? accentTextClass : "text-base-content/45"}`}>
          <ChevronDown className={`nc-model-selector-chevron h-3.5 w-3.5 ${isOpen ? "rotate-180" : ""}`} />
        </span>
      </button>

      {isOpen && mode === "modal" && (
        <ModelSelectorModal
          value={value}
          options={visibleOptions}
          onChange={handleSelect}
          onClose={() => setIsOpen(false)}
          allowCustom={allowCustom}
          customPlaceholder={customPlaceholder}
          variant={variant}
          title={title}
          modelCategory={modelCategory}
          customModels={customModels}
          remoteOptions={remoteOptions}
          remoteEntry={provider ? remoteEntry : undefined}
          onRefreshRemote={() => provider && void fetchModels(provider, true)}
        />
      )}
      {isOpen && mode === "inline" && (
        <ModelSelectorDropdown
          value={value}
          options={visibleOptions}
          onChange={handleSelect}
          allowCustom={allowCustom}
          customPlaceholder={customPlaceholder}
          variant={variant}
          modelCategory={modelCategory}
          customModels={customModels}
          remoteOptions={remoteOptions}
          remoteEntry={provider ? remoteEntry : undefined}
          onRefreshRemote={() => provider && void fetchModels(provider, true)}
        />
      )}
    </div>
  );
}

interface ModelSelectorDropdownProps {
  value: string;
  options: ModelOption[];
  onChange: (value: string) => void;
  allowCustom: boolean;
  customPlaceholder: string;
  variant: "primary" | "warning" | "info";
  modelCategory?: ModelCategory;
  customModels: string[];
  remoteOptions?: ModelOption[];
  remoteEntry?: { models: unknown[]; fetchedAt: number; loading: boolean; error?: string };
  onRefreshRemote?: () => void;
}

interface RemoteEntryState {
  loading: boolean;
  error?: string;
}

function getSelectedBgClass(variant: "primary" | "warning" | "info") {
  switch (variant) {
    case "warning":
      return "bg-warning/10 text-warning border-warning/25";
    case "info":
      return "bg-info/10 text-info border-info/25";
    default:
      return "bg-primary/10 text-primary border-primary/25";
  }
}

function getAccentTextClass(variant: "primary" | "warning" | "info") {
  switch (variant) {
    case "warning":
      return "text-warning";
    case "info":
      return "text-info";
    default:
      return "text-primary";
  }
}

function getAccentSoftClass(variant: "primary" | "warning" | "info") {
  switch (variant) {
    case "warning":
      return "nc-model-selector-add-option bg-warning/10 text-warning border-warning/20 hover:bg-warning/20";
    case "info":
      return "nc-model-selector-add-option bg-info/10 text-info border-info/20 hover:bg-info/20";
    default:
      return "nc-model-selector-add-option bg-primary/10 text-primary border-primary/20 hover:bg-primary/20";
  }
}

function modelMatchesQuery(label: string, value: string, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return `${label} ${value}`.toLowerCase().includes(normalizedQuery);
}

function getOptionAnimationStyle(index: number): CSSProperties {
  return { "--nc-model-option-delay": `${Math.min(Math.max(index, 0) * 28, 168)}ms` } as CSSProperties;
}

// 实时模型区块标题（含刷新按钮与错误提示）
function RemoteSectionHeader({
  remoteEntry,
  onRefreshRemote,
}: {
  remoteEntry?: RemoteEntryState;
  onRefreshRemote?: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-1.5 pb-1">
      <div className="nc-section-title-sm flex items-center gap-1.5">
        <CloudDownload className="h-3 w-3" />
        {remoteEntry?.loading ? "正在获取模型..." : "可用模型（实时）"}
      </div>
      <button
        type="button"
        className="nc-icon-btn nc-icon-btn-xs"
        onClick={() => onRefreshRemote?.()}
        title="刷新模型列表"
        aria-label="刷新模型列表"
      >
        <RefreshCw className={`h-3 w-3 ${remoteEntry?.loading ? "animate-spin" : ""}`} />
      </button>
    </div>
  );
}

function RemoteErrorRow({
  error,
  onRefreshRemote,
}: {
  error: string;
  onRefreshRemote?: () => void;
}) {
  return (
    <div className="mx-1.5 flex items-center gap-2 rounded-lg bg-warning/10 px-2.5 py-2 text-xs text-warning">
      <CircleAlert className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={error}>
        获取失败：{error}
      </span>
      <button
        type="button"
        className="flex-shrink-0 rounded px-1.5 py-0.5 hover:bg-warning/20"
        onClick={() => onRefreshRemote?.()}
      >
        重试
      </button>
    </div>
  );
}

function ModelSelectorDropdown({
  value,
  options,
  onChange,
  allowCustom,
  customPlaceholder,
  variant,
  modelCategory,
  customModels,
  remoteOptions,
  remoteEntry,
  onRefreshRemote,
}: ModelSelectorDropdownProps) {
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { addCustomModel, removeCustomModel } = useCustomModelStore();
  const isCustomModel = !options.some((opt) => opt.value === value) && !customModels.includes(value);
  const trimmedQuery = query.trim();
  const allKnownOptions = [...options, ...(remoteOptions || [])];
  const filteredOptions = options.filter((opt) => modelMatchesQuery(opt.label, opt.value, query));
  const filteredRemoteOptions = (remoteOptions || []).filter((opt) => modelMatchesQuery(opt.label, opt.value, query));
  const filteredCustomModels = customModels.filter((model) => modelMatchesQuery(model, model, query));
  const exactMatchExists = [...allKnownOptions.map((opt) => opt.value), ...customModels].some(
    (model) => model.toLowerCase() === trimmedQuery.toLowerCase()
  );
  const canAddQuery = allowCustom && trimmedQuery.length > 0 && !exactMatchExists;
  const hasResults = filteredOptions.length > 0 || filteredRemoteOptions.length > 0 || filteredCustomModels.length > 0 || canAddQuery;
  const selectedClassName = getSelectedBgClass(variant);
  const addOptionClassName = getAccentSoftClass(variant);

  const handleCustomModelSubmit = (modelName = query) => {
    const trimmed = modelName.trim();
    if (!trimmed) return;
    if (modelCategory) {
      addCustomModel(modelCategory, trimmed);
    }
    onChange(trimmed);
  };

  const handleRemoveCustomModel = (model: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (modelCategory) {
      removeCustomModel(modelCategory, model);
    }
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const firstMatch = filteredOptions[0]?.value || filteredCustomModels[0];
    if (firstMatch) {
      onChange(firstMatch);
      return;
    }
    if (canAddQuery) {
      handleCustomModelSubmit(trimmedQuery);
    }
  };

  const renderPresetOption = (opt: ModelOption) => {
    const selected = value === opt.value;
    const optionIndex = filteredOptions.findIndex((item) => item.value === opt.value);

    return (
      <button
        key={opt.value}
        type="button"
        role="option"
        aria-selected={selected}
        style={getOptionAnimationStyle(optionIndex)}
        className={`
          nc-model-selector-option flex w-full items-start justify-between gap-3 border px-3 py-2.5 text-left text-sm
          ${selected
            ? `nc-model-selector-option-selected ${selectedClassName}`
            : "border-transparent bg-transparent text-base-content hover:border-base-300/45 hover:bg-base-200/55"
          }
        `}
        onClick={() => onChange(opt.value)}
      >
        <span className="min-w-0 flex-1">
          <span className="block line-clamp-2 font-medium leading-5">{opt.label}</span>
          {opt.label !== opt.value && (
            <span className="mt-1 block break-all text-[11px] leading-4 text-base-content/45">
              {opt.value}
            </span>
          )}
        </span>
        {selected && <Check className="nc-model-selector-check mt-0.5 h-4 w-4 flex-shrink-0" />}
      </button>
    );
  };

  const renderCustomOption = (model: string) => {
    const selected = value === model;
    const optionIndex = filteredOptions.length + filteredCustomModels.findIndex((item) => item === model);

    return (
      <div
        key={model}
        style={getOptionAnimationStyle(optionIndex)}
        className={`
          nc-model-selector-option group flex w-full items-center border text-sm
          ${selected
            ? `nc-model-selector-option-selected ${selectedClassName}`
            : "border-transparent bg-transparent text-base-content hover:border-base-300/45 hover:bg-base-200/55"
          }
        `}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center justify-between gap-2 px-3 py-2.5 text-left"
          onClick={() => onChange(model)}
        >
          <span className="min-w-0 flex-1">
            <span className="block break-all font-medium leading-5">{model}</span>
            <span className="mt-1 block text-[11px] leading-4 text-base-content/45">
              自定义模型
            </span>
          </span>
          {selected && <Check className="nc-model-selector-check h-4 w-4" />}
        </button>
        <span className="flex flex-shrink-0 items-center pr-1.5">
          <button
            type="button"
            aria-label={`删除模型 ${model}`}
            className="
              nc-icon-btn nc-icon-btn-xs nc-icon-btn-danger
              opacity-0 group-hover:opacity-100 focus:opacity-100
            "
            onClick={(event) => handleRemoveCustomModel(model, event)}
            title="删除此模型"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
    );
  };

  return (
    <div
      role="listbox"
      className="nc-model-selector-dropdown absolute left-0 right-0 top-full mt-2 overflow-hidden border border-base-300/80 bg-base-100"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="border-b border-base-300/70 bg-base-200/20 p-2.5">
        <div className="nc-model-selector-search group/search flex items-center gap-2 rounded-[var(--nc-radius-md)] border border-base-300/70 bg-base-100 px-2.5 py-2 focus-within:border-[color-mix(in_srgb,var(--nc-focus)_35%,var(--nc-border))]">
          <Search className="nc-model-selector-search-icon h-3.5 w-3.5 flex-shrink-0 text-base-content/35 group-focus-within/search:text-primary/55" />
          <input
            ref={searchInputRef}
            type="text"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-base-content/35 focus:outline-none focus-visible:outline-none"
            placeholder={allowCustom ? customPlaceholder : "搜索模型"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
          {query && (
            <button
              type="button"
              className="nc-model-selector-clear rounded p-0.5 text-base-content/35 hover:bg-base-200 hover:text-base-content/60"
              onClick={() => setQuery("")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="nc-scrollbar-none max-h-[360px] overflow-y-auto p-2">
        {isCustomModel && value && (
          <button
            type="button"
            role="option"
            aria-selected={true}
            style={getOptionAnimationStyle(0)}
            className={`nc-model-selector-option nc-model-selector-option-selected mb-1.5 flex w-full items-center justify-between gap-2 border px-3 py-2.5 text-left text-sm ${selectedClassName}`}
            onClick={() => onChange(value)}
          >
            <span className="min-w-0 flex-1">
              <span className="block break-all font-medium leading-5">{value}</span>
              <span className="mt-0.5 block text-[11px] leading-4 opacity-70">
                当前自定义模型
              </span>
            </span>
            <Check className="nc-model-selector-check h-4 w-4 flex-shrink-0" />
          </button>
        )}

        {filteredOptions.length > 0 && (
          <div className="space-y-1">
            <div className="nc-section-title-sm px-1.5 pb-1 pt-0.5">推荐模型</div>
            {filteredOptions.map(renderPresetOption)}
          </div>
        )}

        {(filteredRemoteOptions.length > 0 || remoteEntry?.error || remoteEntry?.loading) && (
          <div className="mt-2 border-t border-base-300/70 pt-2">
            <RemoteSectionHeader remoteEntry={remoteEntry} onRefreshRemote={onRefreshRemote} />
            {remoteEntry?.error && filteredRemoteOptions.length === 0 && (
              <RemoteErrorRow error={remoteEntry.error} onRefreshRemote={onRefreshRemote} />
            )}
            {filteredRemoteOptions.map(renderPresetOption)}
          </div>
        )}

        {allowCustom && filteredCustomModels.length > 0 && (
          <div className="mt-2 border-t border-base-300/70 pt-2">
            <div className="nc-section-title-sm px-1.5 pb-1">我的模型</div>
            {filteredCustomModels.map(renderCustomOption)}
          </div>
        )}

        {canAddQuery && (
          <div className={filteredOptions.length > 0 || filteredCustomModels.length > 0 ? "mt-2 border-t border-base-300/70 pt-2" : ""}>
            <button
              type="button"
              style={getOptionAnimationStyle(filteredOptions.length + filteredCustomModels.length)}
              className={`nc-model-selector-option flex w-full items-center gap-2 border px-3 py-2.5 text-left text-sm ${addOptionClassName}`}
              onClick={() => handleCustomModelSubmit(trimmedQuery)}
            >
              <Plus className="h-4 w-4 flex-shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block break-all font-medium leading-5">添加 {trimmedQuery}</span>
              </span>
            </button>
          </div>
        )}

        {!hasResults && (
          <div className="px-3 py-6 text-center text-xs text-base-content/45">
            没有匹配的模型
          </div>
        )}

        {allowCustom && !trimmedQuery && customModels.length === 0 && filteredOptions.length > 0 && (
          <div className="mt-2 border-t border-base-300/70 px-1.5 pt-2 text-[11px] text-base-content/35">
            可直接输入兼容模型名称
          </div>
        )}
      </div>
    </div>
  );
}

// Modal 弹窗组件
interface ModelSelectorModalProps {
  value: string;
  options: ModelOption[];
  onChange: (value: string) => void;
  onClose: () => void;
  allowCustom: boolean;
  customPlaceholder: string;
  variant: "primary" | "warning" | "info";
  title: string;
  modelCategory?: ModelCategory;
  customModels: string[];
  remoteOptions?: ModelOption[];
  remoteEntry?: { models: unknown[]; fetchedAt: number; loading: boolean; error?: string };
  onRefreshRemote?: () => void;
}

function ModelSelectorModal({
  value,
  options,
  onChange,
  onClose,
  allowCustom,
  customPlaceholder,
  variant,
  title,
  modelCategory,
  customModels,
  remoteOptions,
  remoteEntry,
  onRefreshRemote,
}: ModelSelectorModalProps) {
  const [customModel, setCustomModel] = useState("");

  // 统一 Modal 交互（ESC 关闭、背景点击、过渡动画）
  const { isVisible, isClosing, handleClose, handleBackdropClick } = useModal({
    isOpen: true,
    onClose,
  });

  const { contentClasses } = getModalAnimationClasses(isVisible, isClosing);

  const { addCustomModel, removeCustomModel } = useCustomModelStore();

  // 检查是否是自定义模型（不在预设/实时列表中，也不在用户自定义列表中）
  const isCustomModel =
    !options.some((opt) => opt.value === value) &&
    !(remoteOptions || []).some((opt) => opt.value === value) &&
    !customModels.includes(value);

  // 选择预设模型
  const handleSelectPreset = (modelValue: string) => {
    onChange(modelValue);
  };

  // 使用自定义模型
  const handleCustomModelSubmit = () => {
    const trimmed = customModel.trim();
    if (trimmed) {
      // 保存到自定义模型列表（如果指定了分类）
      if (modelCategory) {
        addCustomModel(modelCategory, trimmed);
      }
      onChange(trimmed);
    }
  };

  // 删除用户自定义模型
  const handleRemoveCustomModel = (model: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (modelCategory) {
      removeCustomModel(modelCategory, model);
      // 如果删除的是当前选中的模型，不做任何处理，让用户重新选择
    }
  };

  // 获取选中状态的背景色
  const getSelectedBg = () => {
    switch (variant) {
      case "warning":
        return "bg-warning/10 text-warning border border-warning/30";
      case "info":
        return "bg-info/10 text-info border border-info/30";
      default:
        return "bg-primary/10 text-primary border border-primary/30";
    }
  };

  // 获取按钮主题色
  const getButtonTheme = () => {
    switch (variant) {
      case "warning":
        return "btn-warning";
      case "info":
        return "btn-info";
      default:
        return "btn-primary";
    }
  };

  const getHeaderAccent = () => {
    switch (variant) {
      case "warning":
        return "nc-node-accent-orange";
      case "info":
        return "nc-node-accent-cyan";
      default:
        return "nc-node-accent-blue";
    }
  };

  // 与内联下拉一致的选项外观（未选中态）
  const optionIdleClass =
    "nc-model-selector-option flex w-full items-start justify-between gap-3 border px-3 py-2 text-left text-sm border-transparent bg-transparent text-base-content hover:border-base-300/45 hover:bg-base-200/55";

  return createPortal(
    <div
      className={`nc-modal-backdrop p-4 ${isVisible && !isClosing ? "nc-modal-backdrop-open" : ""}`}
      onClick={handleBackdropClick}
    >
      <div
        className={`
          nc-modal nc-modal-sm overflow-hidden
          transition-all duration-200 ease-out
          ${contentClasses}
        `}
        style={{ maxWidth: 320 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className={`nc-modal-header nc-node-header-accent ${getHeaderAccent()}`}>
          <span className="nc-modal-title">{title}</span>
          <button
            type="button"
            className="nc-icon-btn"
            onClick={handleClose}
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 内容区域 */}
        <div className="p-4 space-y-3 max-h-[60vh] overflow-y-auto" role="listbox">
          {/* 预设模型列表（options 为空时不渲染该区块，例如生图节点已改为纯实时列表） */}
          {options.length > 0 && (
            <div className="space-y-1">
              <div className="nc-section-title-sm mb-1.5">预设模型</div>
              {options.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={value === opt.value}
                  className={`
                    ${optionIdleClass}
                    ${value === opt.value ? `nc-model-selector-option-selected ${getSelectedBg()}` : ""}
                  `}
                  onClick={() => handleSelectPreset(opt.value)}
                >
                  <span className="flex flex-col items-start">
                    <span>{opt.label}</span>
                    {opt.label !== opt.value && (
                      <span className="text-xs text-base-content/50">{opt.value}</span>
                    )}
                  </span>
                  {value === opt.value && <Check className="w-4 h-4" />}
                </button>
              ))}
            </div>
          )}

          {/* 实时获取的模型列表 */}
          {(remoteOptions?.length || remoteEntry?.error || remoteEntry?.loading) && (
            <div className="border-t border-base-300 pt-3 space-y-1">
              <RemoteSectionHeader remoteEntry={remoteEntry} onRefreshRemote={onRefreshRemote} />
              {remoteEntry?.error && !remoteOptions?.length && (
                <RemoteErrorRow error={remoteEntry.error} onRefreshRemote={onRefreshRemote} />
              )}
              {(remoteOptions || []).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={value === opt.value}
                  className={`
                    ${optionIdleClass}
                    ${value === opt.value ? `nc-model-selector-option-selected ${getSelectedBg()}` : ""}
                  `}
                  onClick={() => handleSelectPreset(opt.value)}
                >
                  <span className="flex flex-col items-start">
                    <span className="break-all">{opt.label}</span>
                    {opt.label !== opt.value && (
                      <span className="text-xs text-base-content/50">{opt.value}</span>
                    )}
                  </span>
                  {value === opt.value && <Check className="w-4 h-4" />}
                </button>
              ))}
            </div>
          )}

          {/* 用户自定义模型列表 */}
          {allowCustom && customModels.length > 0 && (
            <div className="border-t border-base-300 pt-3 space-y-1">
              <div className="nc-section-title-sm mb-1.5">我的模型</div>
              {customModels.map((model) => (
                <div
                  key={model}
                  role="option"
                  aria-selected={value === model}
                  className={`
                    nc-model-selector-option group w-full py-2 pl-3 pr-1.5 text-left text-sm
                    flex items-center justify-between cursor-pointer
                    ${value === model ? `nc-model-selector-option-selected ${getSelectedBg()}` : "border-transparent bg-transparent text-base-content hover:border-base-300/45 hover:bg-base-200/55"}
                  `}
                  onClick={() => handleSelectPreset(model)}
                >
                  <span className="truncate">{model}</span>
                  <div className="flex items-center gap-1">
                    {value === model && <Check className="w-4 h-4" />}
                    <button
                      type="button"
                      aria-label={`删除模型 ${model}`}
                      className="nc-icon-btn nc-icon-btn-xs nc-icon-btn-danger opacity-0 group-hover:opacity-100 focus:opacity-100"
                      onClick={(e) => handleRemoveCustomModel(model, e)}
                      title="删除此模型"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 自定义模型输入 */}
          {allowCustom && (
            <>
              <div className="border-t border-base-300 pt-3">
                <label className="nc-field-label mb-1.5">添加自定义模型</label>
                {/* 当前自定义模型显示（如果是临时输入的，不在列表中） */}
                {isCustomModel && value && (
                  <div className="mb-2 px-2 py-1.5 bg-primary/10 rounded-lg text-xs text-primary">
                    当前: {value}
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    type="text"
                    className="input input-sm input-bordered flex-1"
                    placeholder={customPlaceholder}
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleCustomModelSubmit();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className={`btn btn-sm ${getButtonTheme()}`}
                    onClick={handleCustomModelSubmit}
                    disabled={!customModel.trim()}
                  >
                    添加
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* 底部 */}
        <div className="nc-modal-footer">
          <span className="nc-modal-footer-hint">
            按 ESC 关闭
          </span>
          <button className="btn btn-ghost btn-sm" onClick={handleClose}>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
