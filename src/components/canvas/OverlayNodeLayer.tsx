import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Position, type Node, type Viewport } from "@xyflow/react";

import { useFlowStore } from "@/stores/flowStore";
import { getGeneratorHandleFingerprint } from "@/utils/generatorHandles";
import {
  getOverlayNodeDescriptor,
  getNodeOverlayHandles,
  type OverlayNodeDescriptor,
  type OverlayNodeHandleSpec,
} from "./overlayNodeRegistry";
import type { CustomEdge, CustomNodeData } from "@/types";

type CustomNode = Node<CustomNodeData>;

interface OverlayNodeLayerProps {
  nodes: CustomNode[];
  edges: CustomEdge[];
  selectedNodeIds: string[];
  hoveredNodeId: string | null;
  viewport: Viewport;
}

// 视口外多大范围的节点仍参与渲染（像素），避免平移时节点频繁挂载/卸载
const CULL_MARGIN_PX = 480;

interface OverlayNodeItemProps {
  node: CustomNode;
  descriptor: OverlayNodeDescriptor;
  /** imageGeneratorNode 动态 handle 的指纹；其余节点类型为空字符串 */
  handlesFingerprint: string;
  selected: boolean;
  hovered: boolean;
  viewport: Viewport;
}

const OverlayNodeItem = memo(function OverlayNodeItem({
  node,
  descriptor,
  handlesFingerprint,
  selected,
  hovered,
  viewport,
}: OverlayNodeItemProps) {
  const width = descriptor.size.width;
  const height = descriptor.size.height;
  const Renderer = descriptor.render;

  // imageGeneratorNode 的 handle 随该节点连线动态变化，其余节点类型使用静态描述
  const handles = useMemo<OverlayNodeHandleSpec[]>(() => {
    if (node.type !== "imageGeneratorNode") {
      return descriptor.handles;
    }
    const { edges, nodes } = useFlowStore.getState();
    return getNodeOverlayHandles(node.id, node.type, edges, nodes);
  }, [node, descriptor, handlesFingerprint]);

  return (
    <div
      className="canvas-node-overlay-item absolute"
      style={{
        left: Math.round(node.position.x * viewport.zoom + viewport.x),
        top: Math.round(node.position.y * viewport.zoom + viewport.y),
        width: Math.round(width * viewport.zoom),
        height: Math.round(height * viewport.zoom),
        zIndex: selected || hovered ? 20 : 10,
        "--canvas-node-zoom": viewport.zoom,
        "--canvas-node-width": `${width}px`,
        "--canvas-node-height": `${height}px`,
      } as CSSProperties}
    >
      <div className="canvas-node-overlay-scale">
        <div className="relative">
          {handles.filter((handle) => handle.showMarker !== false).map((handle) => (
            <div key={`${handle.type}-${handle.id}`}>
              <div
                className={`canvas-node-overlay-handle absolute ${
                  handle.position === Position.Left
                    ? "canvas-node-overlay-handle-left"
                    : handle.position === Position.Right
                      ? "canvas-node-overlay-handle-right"
                      : ""
                } ${handle.className}`}
                style={{
                  top: handle.top || "50%",
                  left: handle.position === Position.Left ? 0 : undefined,
                  right: handle.position === Position.Right ? 0 : undefined,
                }}
              />
              {handle.label && (
                <div
                  className={`absolute text-[11px] text-base-content/50 ${
                    handle.labelClassName || "-left-9"
                  }`}
                  style={{
                    top: handle.top || "50%",
                    transform: "translateY(-100%)",
                  }}
                >
                  {handle.label}
                </div>
              )}
            </div>
          ))}
          <div className="canvas-node-overlay-content">
            <Renderer
              id={node.id}
              type={node.type || ""}
              data={node.data as Record<string, unknown>}
              selected={selected}
              hovered={hovered}
            />
          </div>
        </div>
      </div>
    </div>
  );
});

function isNodeVisible(
  node: CustomNode,
  descriptor: OverlayNodeDescriptor,
  viewport: Viewport,
  size: { width: number; height: number } | null
): boolean {
  if (!size) return true;

  const left = node.position.x * viewport.zoom + viewport.x;
  const top = node.position.y * viewport.zoom + viewport.y;
  const right = left + descriptor.size.width * viewport.zoom;
  const bottom = top + descriptor.size.height * viewport.zoom;

  return (
    right >= -CULL_MARGIN_PX &&
    left <= size.width + CULL_MARGIN_PX &&
    bottom >= -CULL_MARGIN_PX &&
    top <= size.height + CULL_MARGIN_PX
  );
}

export function OverlayNodeLayer({
  nodes,
  edges,
  selectedNodeIds,
  hoveredNodeId,
  viewport,
}: OverlayNodeLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(null);

  // 测量容器尺寸，用于视口裁剪
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) {
        setContainerSize((prev) =>
          prev && prev.width === rect.width && prev.height === rect.height
            ? prev
            : { width: rect.width, height: rect.height }
        );
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const selectedNodeSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);

  const visibleNodes = useMemo(() => {
    // 视口裁剪：只渲染可视范围（含边距）内的节点；选中的节点始终渲染
    return nodes.filter((node) => {
      if (selectedNodeSet.has(node.id) || hoveredNodeId === node.id) return true;
      const descriptor = getOverlayNodeDescriptor(node.type);
      if (!descriptor) return false;
      return isNodeVisible(node, descriptor, viewport, containerSize);
    });
  }, [nodes, selectedNodeSet, hoveredNodeId, viewport, containerSize]);

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
    >
      {visibleNodes.map((node) => {
        const descriptor = getOverlayNodeDescriptor(node.type);
        if (!descriptor) {
          return null;
        }

        // imageGeneratorNode 的 handle 依赖入边（每条参考图连线独占一个槽位），
        // 用原始字符串指纹作为 memo 依赖，避免整层重渲染时无谓地重建 handle 列表
        const handlesFingerprint =
          node.type === "imageGeneratorNode"
            ? getGeneratorHandleFingerprint(node.id, edges, nodes)
            : "";

        return (
          <OverlayNodeItem
            key={node.id}
            node={node}
            descriptor={descriptor}
            handlesFingerprint={handlesFingerprint}
            selected={selectedNodeSet.has(node.id)}
            hovered={hoveredNodeId === node.id}
            viewport={viewport}
          />
        );
      })}
    </div>
  );
}
