import { memo, useEffect, useMemo } from "react";
import { Handle, useUpdateNodeInternals, type NodeProps, type Node } from "@xyflow/react";

import { useFlowStore } from "@/stores/flowStore";
import { getGeneratorHandleFingerprint } from "@/utils/generatorHandles";
import { getOverlayNodeDescriptor, getNodeOverlayHandles } from "./overlayNodeRegistry";
import type { CustomNodeData } from "@/types";

type InteractionNode = Node<CustomNodeData>;

function InteractionNodeShellBase({ id, type }: NodeProps<InteractionNode>) {
  const descriptor = getOverlayNodeDescriptor(type);

  // imageGeneratorNode 的参考图槽位是动态的（依赖该节点的连线）。
  // 订阅原始字符串指纹，只有该节点入边真正变化时才触发重渲染。
  const handlesFingerprint = useFlowStore((s) =>
    type === "imageGeneratorNode" ? getGeneratorHandleFingerprint(id, s.edges, s.nodes) : ""
  );

  const handles = useMemo(() => {
    if (!descriptor) {
      return [];
    }
    if (type !== "imageGeneratorNode") {
      return descriptor.handles;
    }
    const { edges, nodes } = useFlowStore.getState();
    return getNodeOverlayHandles(id, type, edges, nodes);
  }, [descriptor, id, type, handlesFingerprint]);

  // 动态 handle（生图节点参考图槽位）挂载/卸载后必须通知 React Flow 重新测量
  // handleBounds，否则新边在渲染时找不到目标 handle，导致连线保存成功但永不显示
  // （"Couldn't create edge for target handle id"）。
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    if (type !== "imageGeneratorNode") return;
    updateNodeInternals(id);
  }, [updateNodeInternals, id, type, handlesFingerprint]);

  if (!descriptor) {
    return null;
  }

  return (
    <div
      className="canvas-node-interaction-shell relative"
      style={{
        width: descriptor.size.width,
        height: descriptor.size.height,
      }}
    >
      {handles.map((handle) => (
        <Handle
          key={`${handle.type}-${handle.id}`}
          type={handle.type}
          position={handle.position}
          id={handle.id}
          className={handle.className}
          style={{ top: handle.top }}
          title={handle.title}
          isConnectable={handle.isConnectable}
        />
      ))}
    </div>
  );
}

export const InteractionNodeShell = memo(InteractionNodeShellBase);
InteractionNodeShell.displayName = "InteractionNodeShell";
