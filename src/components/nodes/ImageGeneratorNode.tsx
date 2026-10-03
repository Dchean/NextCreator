import { memo, useMemo, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Image as ImageIconBase,
  Loader2,
  Play,
  Sparkles,
} from "lucide-react";
import { useImageGeneratorExecution } from "@/hooks/useImageGeneratorExecution";
import { useNodeConnectionStatus } from "@/hooks/useNodeConnectionStatus";
import { useFlowStore } from "@/stores/flowStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { getImageUrl } from "@/services/fileStorageService";
import { ImagePreviewModal } from "@/components/ui/ImagePreviewModal";
import { ModelSelector } from "@/components/ui/ModelSelector";
import { Select } from "@/components/ui/Select";
import { isFileInputEdge, isImageInputEdge, getGeneratorImageSlotIndex } from "@/utils/connectionHandles";
import type { CustomEdge, CustomNode, Provider } from "@/types";
import type {
  GptImageSize,
  GptImageSizeMode,
  ImageGeneratorNodeData,
  ImageGeneratorNode as ImageGeneratorNodeType,
} from "./imageGeneratorConfig";
import { PromptSourceRow } from "./PromptSourceRow";
import {
  getGeminiAspectRatioOptions,
  getGeminiImageSizeOptions,
  getGptImageCustomDimensions,
  getGptImageSizeMode,
  getImageApiProtocolConfig,
  getImageGeneratorParameterLabels,
  getImageModelDisplayName,
  getOpenAIImageSizeOptions,
  gptImageQualityOptions,
  openAIImageCountOptions,
  supportsCustomOpenAIImageSize,
} from "./imageGeneratorConfig";

/** Gemini 协议节点内联数量选项（并发任务批量拆分） */
const GEMINI_INLINE_COUNT_OPTIONS = ["1", "2", "4"];

function getNodeAccentClass(accent: string) {
  if (accent === "info") return "nc-node-accent-cyan";
  if (accent === "warning") return "nc-node-accent-orange";
  if (accent === "secondary") return "nc-node-accent-pink";
  if (accent === "error") return "nc-node-accent-orange";
  return "nc-node-accent-blue";
}

function getSegActiveClass(accent: string) {
  if (accent === "info") return "nc-seg-btn-info";
  if (accent === "warning") return "nc-seg-btn-warning";
  return "";
}

function getModelSelectorVariant(accent: string): "primary" | "info" {
  if (accent === "info") return "info";
  return "primary";
}

function getStatusLabel(status: ImageGeneratorNodeData["status"]) {
  switch (status) {
    case "loading":
      return "生成中";
    case "success":
      return "已完成";
    case "error":
      return "失败";
    default:
      return "空闲";
  }
}

interface ConnectedInputSource {
  id: string;
  label: string;
}

function getNodeDisplayLabel(node: CustomNode) {
  const rawLabel = typeof node.data.label === "string" ? node.data.label.trim() : "";
  if (rawLabel) return rawLabel;

  switch (node.type) {
    case "promptNode":
      return "提示词";
    case "llmContentNode":
      return "LLM 内容";
    case "imageInputNode":
      return "参考图";
    case "imageGeneratorNode":
      return "绘图生成";
    case "fileUploadNode":
      return "文件上传";
    default:
      return `节点 ${node.id.slice(0, 4)}`;
  }
}

function getConnectedInputSources(
  nodes: CustomNode[],
  edges: CustomEdge[],
  nodeId: string
): ConnectedInputSource[] {
  // 每条参考图连线单独展示（带槽位编号 参考图1/参考图2...），文件输入按来源去重
  const imageEntries: Array<{ edge: CustomEdge; label: string; slotIndex: number | null }> = [];
  const fileSources: ConnectedInputSource[] = [];
  const seenFileSourceIds = new Set<string>();

  for (const edge of edges) {
    if (edge.target !== nodeId) continue;

    const sourceNode = nodes.find((node) => node.id === edge.source);
    if (!sourceNode) continue;
    const targetNode = nodes.find((node) => node.id === edge.target);

    if (isImageInputEdge(edge, sourceNode, targetNode)) {
      const slotIndex = getGeneratorImageSlotIndex(edge.targetHandle);
      const sourceLabel = getNodeDisplayLabel(sourceNode);
      imageEntries.push({
        edge,
        // 动态槽位连线标注编号，便于与左侧连接点一一对应；旧版连线不编号
        label: slotIndex !== null ? `参考图${slotIndex + 1}·${sourceLabel}` : sourceLabel,
        slotIndex,
      });
      continue;
    }

    if (isFileInputEdge(edge, sourceNode, targetNode)) {
      if (seenFileSourceIds.has(sourceNode.id)) continue;
      seenFileSourceIds.add(sourceNode.id);
      fileSources.push({
        id: `file-${sourceNode.id}`,
        label: getNodeDisplayLabel(sourceNode),
      });
    }
  }

  // 参考图按槽位编号升序排列，旧版连线排在最后，保证顺序稳定
  imageEntries.sort((a, b) => {
    const keyA = a.slotIndex ?? Number.MAX_SAFE_INTEGER;
    const keyB = b.slotIndex ?? Number.MAX_SAFE_INTEGER;
    if (keyA !== keyB) return keyA - keyB;
    return 0;
  });

  return [
    ...imageEntries.map((entry) => ({ id: entry.edge.id, label: entry.label })),
    ...fileSources,
  ];
}

function ImageGeneratorNodeBase({ id, data, selected }: NodeProps<ImageGeneratorNodeType>) {
  const nodes = useFlowStore((s) => s.nodes);
  const edges = useFlowStore((s) => s.edges);
  const setSelectedNode = useFlowStore((s) => s.setSelectedNode);
  const updateNodeData = useFlowStore((s) => s.updateNodeData);

  const config = getImageApiProtocolConfig(data);
  const provider = useSettingsStore((s) => s.getNodeProvider(config.providerKey));
  const { handleGenerate, model, sizeValidationError } = useImageGeneratorExecution(id, data);
  const {
    isPromptConnected,
    promptText,
    promptSources,
    hasEmptyImageInputs,
  } = useNodeConnectionStatus(id);
  const statusLabel = getStatusLabel(data.status);
  const hasOutput = Boolean(data.outputImage || data.outputImagePath);
  const isQueued = data.queued === true;

  // 节点内联编辑与右侧 Inspector 共用同一 updateNodeData 通道
  const updateData = (updates: Partial<ImageGeneratorNodeData>) => {
    updateNodeData<ImageGeneratorNodeData>(id, updates);
  };

  // —— 内联参数行的取值逻辑（与 ImageGeneratorInspector 保持一致）——
  const geminiAspectRatioOptions = config.hasGeminiImageControls
    ? getGeminiAspectRatioOptions(model)
    : undefined;
  const geminiImageSizeOptions = config.hasGeminiImageControls
    ? getGeminiImageSizeOptions(model)
    : undefined;
  const currentGeminiAspectRatio = geminiAspectRatioOptions?.some((opt) => opt.value === data.aspectRatio)
    ? data.aspectRatio || geminiAspectRatioOptions?.[0]?.value || "1:1"
    : geminiAspectRatioOptions?.[0]?.value || "1:1";
  const currentGeminiImageSize = geminiImageSizeOptions?.some((opt) => opt.value === data.imageSize)
    ? data.imageSize
    : geminiImageSizeOptions?.[0]?.value;
  const openAIImageSizeOptions = config.hasOpenAIImageControls ? getOpenAIImageSizeOptions(model) : [];
  const canUseCustomOpenAISize = supportsCustomOpenAIImageSize(model);
  const sizeMode = getGptImageSizeMode(data);
  const customDimensions = getGptImageCustomDimensions(data);
  const rawSizeSelectValue = canUseCustomOpenAISize && sizeMode === "custom" ? "custom" : data.size || "auto";
  const sizeSelectValue = openAIImageSizeOptions.some((opt) => opt.value === rawSizeSelectValue)
    ? rawSizeSelectValue
    : "auto";

  // 输出预览（缩略图优先；双击放大；可拖拽到画布生成输入节点）
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const previewSrc = data.outputThumbPath
    ? getImageUrl(data.outputThumbPath)
    : data.outputImagePath
      ? getImageUrl(data.outputImagePath)
      : data.outputImage
        ? `data:image/png;base64,${data.outputImage}`
        : undefined;
  const inlinePrompt = data.prompt || "";
  const hasInlinePrompt = inlinePrompt.trim().length > 0;
  const hasResolvedPrompt = hasInlinePrompt || Boolean(promptText?.trim());
  const canRun = hasResolvedPrompt && data.status !== "loading" && !isQueued && !sizeValidationError;
  const inputSources = useMemo(
    () => getConnectedInputSources(nodes, edges, id),
    [nodes, edges, id]
  );

  return (
    <div className={`${getNodeAccentClass(config.accent)} w-[360px]`}>
      <div
        className={`
          nc-node-card nc-image-info-node transition-all
          ${selected ? "nc-node-card-selected" : ""}
        `}
      >
        <div className="nc-image-info-header">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="nc-node-header-icon">
              <Sparkles className="w-4 h-4" />
            </span>
            <span className="nc-node-title truncate">{data.label || "绘图生成"}</span>
          </div>
          <div className="flex flex-shrink-0 items-center gap-1.5">
            {!hasResolvedPrompt && (
              <div>
                <CircleAlert className="w-4 h-4 text-warning" />
              </div>
            )}
            {isPromptConnected && hasEmptyImageInputs && (
              <div>
                <AlertTriangle className="w-4 h-4 text-warning" />
              </div>
            )}
            {data.status === "loading" && <Loader2 className="w-4 h-4 animate-spin text-info" />}
            {isQueued && data.status !== "loading" && <Clock3 className="w-4 h-4 text-info" />}
            {hasOutput && <ImageIconBase className="w-4 h-4 text-success" />}
            <button
              type="button"
              className={`nodrag nc-node-run-button ${data.status === "loading" ? "nc-node-run-button-loading" : ""}`}
              disabled={!canRun}
              aria-label={data.status === "success" ? "重新运行此节点" : "运行此节点"}
              onClick={(event) => {
                event.stopPropagation();
                if (canRun) {
                  void handleGenerate();
                }
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {data.status === "loading" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5 fill-current" />
              )}
            </button>
          </div>
        </div>

        <div className="space-y-3 px-4 py-3">
          <div className="space-y-2 text-sm">
            <PromptSourceRow
              hasInlinePrompt={hasInlinePrompt}
              inlineCharCount={inlinePrompt.length}
              promptSources={promptSources}
            />
            <InlineModelRow
              value={model}
              options={[]}
              provider={provider}
              variant={getModelSelectorVariant(config.accent)}
              onSelect={(value) => updateData({ model: value })}
            />
            <InputInfoRow sources={inputSources} />
            <InlineParamsRow
              accent={config.accent}
              geminiAspectRatioOptions={geminiAspectRatioOptions}
              geminiImageSizeOptions={geminiImageSizeOptions}
              currentGeminiAspectRatio={currentGeminiAspectRatio}
              currentGeminiImageSize={currentGeminiImageSize || ""}
              openAIImageSizeOptions={openAIImageSizeOptions}
              canUseCustomOpenAISize={canUseCustomOpenAISize}
              sizeMode={sizeMode}
              customDimensions={customDimensions}
              sizeSelectValue={sizeSelectValue}
              quality={data.quality || "auto"}
              count={data.n || 1}
              onUpdate={updateData}
              onOpenInspector={() => setSelectedNode(id)}
            />
          </div>
        </div>

        {/* 输出预览区：双击放大，拖拽到画布空白处可转为图片输入节点 */}
        <div className="px-4 pb-3">
          {previewSrc ? (
            <button
              type="button"
              className="group relative block w-full cursor-zoom-in overflow-hidden rounded-[var(--nc-radius-md)] border border-base-300/60 bg-base-200"
              title="双击放大预览；拖拽图片到画布可复用为输入"
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => {
                event.stopPropagation();
                setShowPreviewModal(true);
              }}
            >
              <img
                src={previewSrc}
                alt="输出预览"
                draggable
                loading="lazy"
                decoding="async"
                className="h-[150px] w-full cursor-grab object-cover"
                onDragStart={(event) => {
                  if (!data.outputImagePath) {
                    event.preventDefault();
                    return;
                  }
                  event.stopPropagation();
                  event.dataTransfer.setData(
                    "application/x-nc-image-ref",
                    JSON.stringify({
                      imagePath: data.outputImagePath,
                      fileName: "生成图片",
                      sourceId: id,
                    })
                  );
                  event.dataTransfer.effectAllowed = "copy";
                }}
                onPointerDown={(event) => event.stopPropagation()}
              />
              <span className="nc-overlay-hint opacity-0 transition-opacity group-hover:opacity-100">
                双击放大 · 可拖拽
              </span>
            </button>
          ) : (
            <div className="flex h-[88px] items-center justify-center rounded-[var(--nc-radius-md)] border border-dashed border-base-300 bg-base-200/40 text-[11px] text-base-content/35">
              {data.status === "loading" ? "生成中..." : "输出预览"}
            </div>
          )}
        </div>

      </div>

      {(data.status !== "idle" || isQueued) && (
        <div className={`nc-node-run-feedback nc-node-run-feedback-${data.status === "idle" && isQueued ? "loading" : data.status}`}>
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className={`nodrag flex min-w-0 flex-1 items-center gap-2 text-left ${data.status === "error" && data.error ? "cursor-pointer" : "cursor-default"}`}
              onClick={(event) => {
                event.stopPropagation();
                if (data.status === "error" && data.error) {
                  setSelectedNode(id);
                }
              }}
              onPointerDown={(event) => event.stopPropagation()}
              aria-label={data.status === "error" && data.error ? "在右侧查看错误详情" : statusLabel}
            >
              {data.status === "loading" ? (
                <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
              ) : isQueued && data.status === "idle" ? (
                <Clock3 className="h-3.5 w-3.5 flex-shrink-0" />
              ) : data.status === "success" ? (
                <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
              ) : (
                <CircleAlert className="h-3.5 w-3.5 flex-shrink-0" />
              )}
              <span className="truncate text-xs font-medium">
                {isQueued && data.status === "idle" ? "排队中" : statusLabel}
              </span>
              {data.status === "error" && data.error && (
                <span className="min-w-0 flex-1 truncate text-xs opacity-75">{data.error}</span>
              )}
            </button>
            <div className="flex flex-shrink-0 items-center gap-2 text-[11px] opacity-70">
              {data.status === "success" && (
                <span>{getOutputCountLabel(data)}</span>
              )}
              {data.status === "error" && data.error && (
                <span className="nc-node-error-detail-hint">查看详情</span>
              )}
            </div>
          </div>
        </div>
      )}

      {showPreviewModal && (data.outputImage || data.outputImagePath) && (
        <ImagePreviewModal
          imageData={data.outputImage}
          imagePath={data.outputImagePath}
          onClose={() => setShowPreviewModal(false)}
        />
      )}
    </div>
  );
}

function getOutputCountLabel(data: ImageGeneratorNodeData) {
  const count = data.outputImagePaths?.length || data.outputImages?.length || (data.outputImage || data.outputImagePath ? 1 : 0);
  if (count > 0) return `${count} 张`;
  return "已完成";
}

interface InlineModelRowProps {
  value: string;
  options: Array<{ value: string; label: string }>;
  provider: Provider | null | undefined;
  variant: "primary" | "warning" | "info";
  onSelect: (value: string) => void;
}

/** 模型行：modal 模式 ModelSelector（弹窗避开画布 transform），节点内仅渲染紧凑触发按钮 */
function InlineModelRow({ value, options, provider, variant, onSelect }: InlineModelRowProps) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="nc-node-row-label w-12">模型:</span>
      <div className="nc-node-model-selector min-w-0 flex-1">
        <ModelSelector
          value={value}
          options={options}
          onChange={onSelect}
          variant={variant}
          allowCustom
          title="选择模型"
          mode="modal"
          provider={provider}
          modelCategory="imageGenerator"
        />
      </div>
    </div>
  );
}

interface InlineParamsRowProps {
  accent: string;
  geminiAspectRatioOptions?: Array<{ value: string; label: string }>;
  geminiImageSizeOptions?: Array<{ value: string; label: string }>;
  currentGeminiAspectRatio: string;
  currentGeminiImageSize: string;
  openAIImageSizeOptions: Array<{ value: string; label: string }>;
  canUseCustomOpenAISize: boolean;
  sizeMode: GptImageSizeMode;
  customDimensions: { width: number; height: number };
  sizeSelectValue: string;
  quality: string;
  count: number;
  onUpdate: (updates: Partial<ImageGeneratorNodeData>) => void;
  /** OpenAI 自定义尺寸的完整编辑器在右侧 Inspector，点击芯片选中节点打开 */
  onOpenInspector: () => void;
}

/** 参数行：按协议渲染内联控件（Gemini：比例/尺寸/数量；OpenAI：尺寸/质量/数量） */
function InlineParamsRow({
  accent,
  geminiAspectRatioOptions,
  geminiImageSizeOptions,
  currentGeminiAspectRatio,
  currentGeminiImageSize,
  openAIImageSizeOptions,
  canUseCustomOpenAISize,
  sizeMode,
  customDimensions,
  sizeSelectValue,
  quality,
  count,
  onUpdate,
  onOpenInspector,
}: InlineParamsRowProps) {
  const renderCountButton = (countValue: string) => (
    <button
      key={countValue}
      type="button"
      className={`nc-seg-btn nc-seg-btn-xs ${count === Number(countValue) ? `nc-seg-btn-active ${getSegActiveClass(accent)}` : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onUpdate({ n: Number(countValue) });
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {countValue}
    </button>
  );

  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="nc-node-row-label w-12 pt-1.5">参数:</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1.5">
        {geminiAspectRatioOptions && geminiAspectRatioOptions.length > 0 && (
          <div className="flex min-w-0 items-center gap-1">
            <span className="flex-shrink-0 text-[11px] text-base-content/45">比例</span>
            <Select
              size="xs"
              className="w-[74px]"
              value={currentGeminiAspectRatio}
              options={geminiAspectRatioOptions}
              onChange={(value) => onUpdate({ aspectRatio: value })}
            />
          </div>
        )}
        {geminiImageSizeOptions && geminiImageSizeOptions.length > 0 && (
          <div className="flex min-w-0 items-center gap-1">
            <span className="flex-shrink-0 text-[11px] text-base-content/45">尺寸</span>
            <Select
              size="xs"
              className="w-[58px]"
              value={currentGeminiImageSize}
              options={geminiImageSizeOptions}
              onChange={(value) => onUpdate({ imageSize: value })}
            />
          </div>
        )}
        {geminiAspectRatioOptions && (
          <div className="flex items-center gap-1">
            <span className="flex-shrink-0 text-[11px] text-base-content/45">数量</span>
            <div className="flex gap-1">
              {GEMINI_INLINE_COUNT_OPTIONS.map(renderCountButton)}
            </div>
          </div>
        )}

        {openAIImageSizeOptions.length > 0 && (
          <div className="flex min-w-0 items-center gap-1">
            <span className="flex-shrink-0 text-[11px] text-base-content/45">尺寸</span>
            <Select
              size="xs"
              className="w-[104px]"
              value={sizeSelectValue}
              options={openAIImageSizeOptions}
              onChange={(nextValue) => {
                const value = nextValue as GptImageSize | "custom";
                if (value === "custom" && canUseCustomOpenAISize) {
                  onUpdate({
                    sizeMode: "custom",
                    customWidth: customDimensions.width,
                    customHeight: customDimensions.height,
                  });
                  return;
                }
                onUpdate({
                  sizeMode: "preset",
                  size: value === "custom" ? "auto" : value,
                });
              }}
            />
            {canUseCustomOpenAISize && sizeMode === "custom" && (
              <button
                type="button"
                className="nc-image-parameter-chip cursor-pointer"
                title={`${customDimensions.width}x${customDimensions.height} · 点击在右侧检查器中调整`}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenInspector();
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                {`${customDimensions.width}x${customDimensions.height}`}
              </button>
            )}
          </div>
        )}
        {openAIImageSizeOptions.length > 0 && (
          <div className="flex items-center gap-1">
            <span className="flex-shrink-0 text-[11px] text-base-content/45">质量</span>
            <Select
              size="xs"
              className="w-[60px]"
              value={quality}
              options={gptImageQualityOptions}
              onChange={(value) =>
                onUpdate({ quality: value as ImageGeneratorNodeData["quality"] })
              }
            />
          </div>
        )}
        {openAIImageSizeOptions.length > 0 && (
          <div className="flex items-center gap-1">
            <span className="flex-shrink-0 text-[11px] text-base-content/45">数量</span>
            <div className="flex gap-1">
              {openAIImageCountOptions.map((opt) => renderCountButton(opt.value))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface InputInfoRowProps {
  sources: ConnectedInputSource[];
}

function InputInfoRow({ sources }: InputInfoRowProps) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="nc-node-row-label w-12 pt-1">参考:</span>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {sources.length > 0 ? (
          sources.map((source) => (
            <span key={source.id} className="nc-image-input-source-chip">
              {source.label}
            </span>
          ))
        ) : (
          <span className="nc-image-input-source-chip nc-image-input-source-chip-empty">
            未连接
          </span>
        )}
      </div>
    </div>
  );
}

export const ImageGeneratorNode = memo(ImageGeneratorNodeBase);
ImageGeneratorNode.displayName = "ImageGeneratorNode";

export function getImageGeneratorInspectorSummary(data: ImageGeneratorNodeData) {
  const config = getImageApiProtocolConfig(data);
  return {
    protocolLabel: config.label,
    modelLabel: getImageModelDisplayName(data),
    parameterLabels: getImageGeneratorParameterLabels(data),
  };
}
