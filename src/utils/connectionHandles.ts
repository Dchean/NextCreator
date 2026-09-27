import type { Edge, Node } from "@xyflow/react";

export const IMAGE_GENERATOR_UNIFIED_INPUT_HANDLE = "input";
export const LLM_CONTENT_UNIFIED_INPUT_HANDLE = "input";

/** 生图节点固定提示词输入 handle */
export const IMAGE_GENERATOR_PROMPT_INPUT_HANDLE = "input-prompt";
/** 旧版统一输入 handle（历史画布兼容别名，新连接不再使用） */
export const IMAGE_GENERATOR_LEGACY_UNIFIED_INPUT_HANDLE = IMAGE_GENERATOR_UNIFIED_INPUT_HANDLE;
/** 旧版固定图片输入 handle（历史画布兼容别名，新连接不再使用） */
export const IMAGE_GENERATOR_LEGACY_IMAGE_INPUT_HANDLE = "input-image";
/** 动态参考图槽位 handle 前缀，完整 id 形如 `input-image-0`..`input-image-5` */
export const IMAGE_GENERATOR_IMAGE_SLOT_PREFIX = "input-image-";
/** 参考图槽位数量上限 */
export const IMAGE_GENERATOR_MAX_IMAGE_SLOTS = 6;
/** 动态参考图槽位 handle（`input-image-{数字}`） */
export const GENERATOR_IMAGE_SLOT_HANDLE_PATTERN = /^input-image-(\d+)$/;

/** 是否为动态参考图槽位 handle（`input-image-{k}`） */
export function isGeneratorImageSlotHandle(targetHandle?: string | null): boolean {
  return !!targetHandle && GENERATOR_IMAGE_SLOT_HANDLE_PATTERN.test(targetHandle);
}

/** 解析参考图槽位编号；非槽位 handle（含旧版 "input-image"）返回 null */
export function getGeneratorImageSlotIndex(targetHandle?: string | null): number | null {
  const match = targetHandle ? GENERATOR_IMAGE_SLOT_HANDLE_PATTERN.exec(targetHandle) : null;
  return match ? Number(match[1]) : null;
}

/**
 * 图片连线在收集输入时的稳定排序键：按槽位编号升序，旧版/无编号连线排在最后。
 * sort 是稳定排序，非图片连线的相对顺序不受影响。
 */
export function getImageSlotSortKey(edge: Edge): number {
  const index = getGeneratorImageSlotIndex(edge.targetHandle);
  return index === null ? Number.MAX_SAFE_INTEGER : index;
}

export function isImageGeneratorUnifiedInput(
  targetNodeType: string | undefined,
  targetHandle?: string | null
) {
  return targetNodeType === "imageGeneratorNode" && targetHandle === IMAGE_GENERATOR_UNIFIED_INPUT_HANDLE;
}

export function isLLMContentUnifiedInput(
  targetNodeType: string | undefined,
  targetHandle?: string | null
) {
  return targetNodeType === "llmContentNode" && targetHandle === LLM_CONTENT_UNIFIED_INPUT_HANDLE;
}

export function isPromptLikeSourceType(sourceNodeType: string | undefined) {
  return sourceNodeType === "promptNode" || sourceNodeType === "llmContentNode";
}

export function isImageLikeSourceType(sourceNodeType: string | undefined) {
  return sourceNodeType === "imageInputNode" || sourceNodeType === "imageGeneratorNode";
}

export function isFileLikeSourceType(sourceNodeType: string | undefined) {
  return sourceNodeType === "fileUploadNode";
}

export function isPromptInputEdge(
  edge: Edge,
  sourceNode: Node,
  targetNode?: Node
) {
  return (
    edge.targetHandle === IMAGE_GENERATOR_PROMPT_INPUT_HANDLE ||
    (
      isImageGeneratorUnifiedInput(targetNode?.type, edge.targetHandle) &&
      isPromptLikeSourceType(sourceNode.type)
    ) ||
    (
      isLLMContentUnifiedInput(targetNode?.type, edge.targetHandle) &&
      isPromptLikeSourceType(sourceNode.type)
    ) ||
    (!edge.targetHandle && isPromptLikeSourceType(sourceNode.type))
  );
}

export function isImageInputEdge(
  edge: Edge,
  sourceNode: Node,
  targetNode?: Node
) {
  return (
    // 覆盖旧版固定 "input-image" 与动态槽位 "input-image-{k}"
    (edge.targetHandle === IMAGE_GENERATOR_LEGACY_IMAGE_INPUT_HANDLE ||
      isGeneratorImageSlotHandle(edge.targetHandle)) ||
    (
      isImageGeneratorUnifiedInput(targetNode?.type, edge.targetHandle) &&
      isImageLikeSourceType(sourceNode.type)
    ) ||
    (
      isLLMContentUnifiedInput(targetNode?.type, edge.targetHandle) &&
      isImageLikeSourceType(sourceNode.type)
    ) ||
    (!edge.targetHandle && isImageLikeSourceType(sourceNode.type))
  );
}

export function isFileInputEdge(
  edge: Edge,
  sourceNode: Node,
  targetNode?: Node
) {
  return (
    edge.targetHandle === "input-file" ||
    (
      isLLMContentUnifiedInput(targetNode?.type, edge.targetHandle) &&
      isFileLikeSourceType(sourceNode.type)
    ) ||
    (!edge.targetHandle && isFileLikeSourceType(sourceNode.type))
  );
}
