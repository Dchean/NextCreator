import type { CustomEdge, CustomNode } from "@/types";

/**
 * 当前版本支持的节点类型。
 * 旧版本画布可能包含视频 / PPT 节点（已在 v0.3.0 精简中移除），
 * 加载时需要过滤，否则 React Flow 渲染未注册类型会报错。
 */
export const SUPPORTED_NODE_TYPES = new Set([
  "promptNode",
  "imageInputNode",
  "imageGeneratorNode",
  "llmContentNode",
  "fileUploadNode",
]);

/**
 * 过滤画布数据中已不受支持的节点类型及其关联连线。
 * 返回新的 nodes/edges 数组（无失效节点时返回原引用）。
 */
export function sanitizeCanvasData(
  nodes: CustomNode[],
  edges: CustomEdge[]
): { nodes: CustomNode[]; edges: CustomEdge[]; removedCount: number } {
  const unsupported = nodes.filter((n) => !SUPPORTED_NODE_TYPES.has(n.type || ""));
  if (unsupported.length === 0) {
    return { nodes, edges, removedCount: 0 };
  }

  const removedIds = new Set(unsupported.map((n) => n.id));
  const nextNodes = nodes.filter((n) => !removedIds.has(n.id));
  const nextEdges = edges.filter(
    (e) => !removedIds.has(e.source) && !removedIds.has(e.target)
  );

  return { nodes: nextNodes, edges: nextEdges, removedCount: unsupported.length };
}
