import { useCanvasStore } from "@/stores/canvasStore";
import { useFlowStore } from "@/stores/flowStore";
import type { CustomNode } from "@/types";

const IS_WINDOWS =
  typeof navigator !== "undefined" && /win/i.test(navigator.platform || navigator.userAgent);

function normalizeRoot(root: string): string {
  return root.trim().replace(/[\\/]+$/, "");
}

function sameRoot(a: string, b: string): boolean {
  const na = normalizeRoot(a).toLowerCase();
  const nb = normalizeRoot(b).toLowerCase();
  return na === nb;
}

/**
 * 将以 oldRoot 开头的路径前缀替换为 newRoot。
 * 兼容正反斜杠与 Windows 大小写不敏感的路径。
 * 非目标路径原样返回。
 */
export function replacePathPrefix(value: string, oldRoot: string, newRoot: string): string {
  const from = normalizeRoot(oldRoot);
  const to = normalizeRoot(newRoot);
  if (!from || !to || sameRoot(from, to)) return value;

  const candidates = [`${from}\\`, `${from}/`];
  if (IS_WINDOWS) {
    for (const candidate of candidates) {
      if (value.toLowerCase().startsWith(candidate.toLowerCase())) {
        return to + value.slice(candidate.length);
      }
    }
  } else {
    for (const candidate of candidates) {
      if (value.startsWith(candidate)) {
        return to + value.slice(candidate.length);
      }
    }
  }
  return value;
}

function rewriteInPlace(value: unknown, oldRoot: string, newRoot: string, depth: number): unknown {
  if (depth > 8) return value;

  if (typeof value === "string") {
    // 只处理看起来像绝对路径的字符串，避免误伤 base64 / URL / 普通文本
    if (value.startsWith(oldRoot) || (IS_WINDOWS && value.toLowerCase().startsWith(oldRoot.toLowerCase()))) {
      return replacePathPrefix(value, oldRoot, newRoot);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => rewriteInPlace(item, oldRoot, newRoot, depth + 1));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    let changed = false;
    for (const [key, item] of Object.entries(value)) {
      const next = rewriteInPlace(item, oldRoot, newRoot, depth + 1);
      if (next !== item) changed = true;
      result[key] = next;
    }
    return changed ? result : value;
  }

  return value;
}

/** 判断字符串是否像本地绝对路径（C:\... 或 /... 或 \\...） */
function looksLikeAbsPath(value: string): boolean {
  return /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(value);
}

// 深度遍历节点数据，收集所有像本地绝对路径的字符串。
// 覆盖 imagePath / maskImagePath / outputImagePath / outputImagePaths /
// outputThumbPath(s) 以及 runRecords.output.imagePaths 等深层字段。
function collectAbsPaths(value: unknown, depth: number, out: Set<string>): void {
  if (depth > 8) return;

  if (typeof value === "string") {
    if (looksLikeAbsPath(value)) {
      out.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectAbsPaths(item, depth + 1, out);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectAbsPaths(item, depth + 1, out);
    }
  }
}

/**
 * 收集所有画布（活动画布 flowStore + 全部持久化画布 canvasStore）
 * 节点数据中引用的本地图片绝对路径。
 * 用途：
 * - 重启后为外部原图重新授予 asset protocol 访问权限；
 * - 清理未引用图片时构造保留集合。
 */
export function collectReferencedImagePaths(): string[] {
  const paths = new Set<string>();

  // 1. 当前活动画布（flowStore 是当前节点的 source of truth）
  for (const node of useFlowStore.getState().nodes) {
    collectAbsPaths(node.data, 0, paths);
  }

  // 2. 所有持久化画布
  for (const canvas of useCanvasStore.getState().canvases) {
    for (const node of canvas.nodes) {
      collectAbsPaths(node.data, 0, paths);
    }
  }

  return Array.from(paths);
}

function rewriteNodeData(data: Record<string, unknown>, oldRoot: string, newRoot: string) {
  const next: Record<string, unknown> = {};
  let changed = false;
  for (const [key, item] of Object.entries(data)) {
    // 已知路径字段直接替换；其余字段递归兜底（如 runRecords 中的 imagePaths）
    if (typeof item === "string" && looksLikeAbsPath(item)) {
      const replaced = replacePathPrefix(item, oldRoot, newRoot);
      if (replaced !== item) changed = true;
      next[key] = replaced;
    } else {
      const rewritten = rewriteInPlace(item, oldRoot, newRoot, 0);
      if (rewritten !== item) changed = true;
      next[key] = rewritten;
    }
  }
  return changed ? next : null;
}

function rewriteNodes(nodes: CustomNode[], oldRoot: string, newRoot: string): CustomNode[] | null {
  let anyChanged = false;
  const next = nodes.map((node) => {
    const newData = rewriteNodeData(node.data as Record<string, unknown>, oldRoot, newRoot);
    if (!newData) return node;
    anyChanged = true;
    return { ...node, data: newData } as CustomNode;
  });
  return anyChanged ? next : null;
}

/**
 * 迁移存储目录后，更新所有画布节点数据中的图片绝对路径。
 * 同时更新 flowStore（当前活动画布）与 canvasStore（全部画布）。
 */
export function rewriteStoredImagePaths(oldRoot: string, newRoot: string): void {
  if (sameRoot(oldRoot, newRoot)) return;

  // 1. 当前活动画布（flowStore 是当前节点的 source of truth）
  const flow = useFlowStore.getState();
  const nextNodes = rewriteNodes(flow.nodes, oldRoot, newRoot);
  if (nextNodes) {
    flow.setNodes(nextNodes);
  }

  // 2. 所有持久化画布
  const canvasStore = useCanvasStore.getState();
  const canvases = canvasStore.canvases;
  let canvasesChanged = false;
  const nextCanvases = canvases.map((canvas) => {
    const next = rewriteNodes(canvas.nodes, oldRoot, newRoot);
    if (!next) return canvas;
    canvasesChanged = true;
    return { ...canvas, nodes: next };
  });
  if (canvasesChanged) {
    useCanvasStore.setState({ canvases: nextCanvases });
  }
}
