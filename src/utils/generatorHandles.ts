/**
 * 生图节点（imageGeneratorNode）连接点动态计算
 *
 * 设计目标：提示词与参考图使用不同的连接点，每条参考图连线独占一个连接点。
 *
 * Handle 命名规则：
 * - `input-prompt`      固定提示词输入（左上 ~35%）
 * - `input-image-{k}`   动态参考图槽位（k = 0..5，上限 6），每条已连接的参考图连线
 *                       永久拥有自己的槽位 id（不会被重新编号）
 * - `output-image`      固定图片输出（右侧）
 * - `input` / `input-image`  旧版兼容 handle：仅当画布上仍存在指向它们的旧连线时才渲染，
 *                       用于保持旧边附着/可见；不可发起新连接
 *
 * 可见槽位数 = 已连接参考图连线数 + 1 个空闲槽位（总数不超过 6；已满 6 条时不渲染空闲槽位）。
 * 空闲槽位取最小未占用编号；旧版兼容连线按图片连线计数参与上限统计。
 */

import { Position, type Edge, type Node } from "@xyflow/react";

import type { OverlayNodeHandleSpec } from "@/components/canvas/overlayNodeRegistry";
import {
  IMAGE_GENERATOR_IMAGE_SLOT_PREFIX,
  IMAGE_GENERATOR_LEGACY_IMAGE_INPUT_HANDLE,
  IMAGE_GENERATOR_LEGACY_UNIFIED_INPUT_HANDLE,
  IMAGE_GENERATOR_MAX_IMAGE_SLOTS,
  IMAGE_GENERATOR_PROMPT_INPUT_HANDLE,
  GENERATOR_IMAGE_SLOT_HANDLE_PATTERN,
  isImageLikeSourceType,
} from "@/utils/connectionHandles";

/** 生图节点固定 handle 的纵向位置（节点高度 600px） */
export const GENERATOR_PROMPT_HANDLE_TOP = "35%";
export const GENERATOR_OUTPUT_HANDLE_TOP = "35%";
/** 旧版统一输入 handle 的历史位置，保持旧画布视觉不变 */
export const GENERATOR_LEGACY_INPUT_TOP = 116;

/** 参考图槽位纵向分布：35% 的提示词点之下，从 43% 开始，每个槽位间隔 9% */
const IMAGE_SLOT_TOP_START = 43;
const IMAGE_SLOT_TOP_STEP = 9;

export function getGeneratorImageSlotTop(slotIndex: number): string {
  return `${IMAGE_SLOT_TOP_START + slotIndex * IMAGE_SLOT_TOP_STEP}%`;
}

function promptHandleSpec(): OverlayNodeHandleSpec {
  return {
    id: IMAGE_GENERATOR_PROMPT_INPUT_HANDLE,
    type: "target",
    position: Position.Left,
    top: GENERATOR_PROMPT_HANDLE_TOP,
    className: "!w-3 !h-3 !bg-blue-500 !border-2 !border-white",
    title: "提示词",
  };
}

function imageSlotHandleSpec(slotIndex: number, title: string): OverlayNodeHandleSpec {
  return {
    id: `${IMAGE_GENERATOR_IMAGE_SLOT_PREFIX}${slotIndex}`,
    type: "target",
    position: Position.Left,
    top: getGeneratorImageSlotTop(slotIndex),
    className: "!w-3 !h-3 !bg-green-500 !border-2 !border-white",
    title,
  };
}

/**
 * 计算 imageGeneratorNode 的 handle 列表（动态，依赖该节点的连线）。
 * 其他节点类型仍使用 overlayNodeRegistry 的静态描述。
 */
export function computeGeneratorHandleSpecs(
  nodeId: string,
  edges: Edge[],
  nodes: Node[]
): OverlayNodeHandleSpec[] {
  const occupiedSlots = new Set<number>();
  let legacyImageEdgeCount = 0;
  let hasLegacyUnifiedInput = false;
  let hasLegacyImageInput = false;

  const sourceTypeById = new Map(nodes.map((node) => [node.id, node.type]));

  for (const edge of edges) {
    if (edge.target !== nodeId) continue;
    const targetHandle = edge.targetHandle ?? null;

    const slotMatch = targetHandle
      ? GENERATOR_IMAGE_SLOT_HANDLE_PATTERN.exec(targetHandle)
      : null;
    if (slotMatch) {
      occupiedSlots.add(Number(slotMatch[1]));
      continue;
    }

    if (targetHandle === IMAGE_GENERATOR_LEGACY_UNIFIED_INPUT_HANDLE) {
      // 旧版统一输入：按来源类型归类；无论何种来源都保留 handle 以维持旧边附着
      hasLegacyUnifiedInput = true;
      const sourceType = sourceTypeById.get(edge.source);
      if (sourceType && isImageLikeSourceType(sourceType)) {
        legacyImageEdgeCount += 1;
      }
      continue;
    }

    if (targetHandle === IMAGE_GENERATOR_LEGACY_IMAGE_INPUT_HANDLE) {
      hasLegacyImageInput = true;
      legacyImageEdgeCount += 1;
    }
  }

  const specs: OverlayNodeHandleSpec[] = [promptHandleSpec()];

  // 旧版兼容 handle：仅在有旧边时渲染，保证旧边附着且不可发起新连接
  if (hasLegacyUnifiedInput) {
    specs.push({
      id: IMAGE_GENERATOR_LEGACY_UNIFIED_INPUT_HANDLE,
      type: "target",
      position: Position.Left,
      top: GENERATOR_LEGACY_INPUT_TOP,
      className: "canvas-node-minimal-handle canvas-node-minimal-handle-input",
      title: "输入（旧版连线）",
      isConnectable: false,
    });
  }
  if (hasLegacyImageInput) {
    specs.push({
      id: IMAGE_GENERATOR_LEGACY_IMAGE_INPUT_HANDLE,
      type: "target",
      position: Position.Left,
      top: GENERATOR_LEGACY_INPUT_TOP,
      className: "canvas-node-legacy-handle",
      isConnectable: false,
      showMarker: false,
    });
  }

  // 已占用的参考图槽位（编号稳定，不会重新编号）
  for (const slotIndex of [...occupiedSlots].sort((a, b) => a - b)) {
    specs.push(imageSlotHandleSpec(slotIndex, `参考图${slotIndex + 1}`));
  }

  // 空闲槽位：取最小未占用编号；参考图连线已满 6 条时不再提供空闲槽位
  const connectedImageCount = occupiedSlots.size + legacyImageEdgeCount;
  if (connectedImageCount < IMAGE_GENERATOR_MAX_IMAGE_SLOTS) {
    let freeSlotIndex = 0;
    while (occupiedSlots.has(freeSlotIndex)) {
      freeSlotIndex += 1;
    }
    specs.push(imageSlotHandleSpec(freeSlotIndex, "参考图（可连接）"));
  }

  specs.push({
    id: "output-image",
    type: "source",
    position: Position.Right,
    top: GENERATOR_OUTPUT_HANDLE_TOP,
    className: "canvas-node-minimal-handle canvas-node-minimal-handle-output",
    title: "输出图片",
  });

  return specs;
}

/**
 * 生图节点 handle 依赖的指纹（该节点入边 + 各来源节点类型）。
 * 作为原始字符串供 selector / memo 使用，避免无关状态变化触发重渲染。
 */
export function getGeneratorHandleFingerprint(
  nodeId: string,
  edges: Edge[],
  nodes: Node[]
): string {
  const parts: string[] = [];
  for (const edge of edges) {
    if (edge.target !== nodeId) continue;
    const sourceType =
      nodes.find((node) => node.id === edge.source)?.type ?? "";
    parts.push(`${edge.id}:${edge.targetHandle ?? ""}:${sourceType}`);
  }
  return parts.sort().join("|");
}
