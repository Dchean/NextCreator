import { Position, type Edge, type Node, type NodeProps } from "@xyflow/react";
import type { ComponentType, CSSProperties } from "react";

import { PromptNode } from "@/components/nodes/PromptNode";
import { ImageGeneratorNode } from "@/components/nodes/ImageGeneratorNode";
import { ImageInputNode } from "@/components/nodes/ImageInputNode";
import { LLMContentNode } from "@/components/nodes/LLMContentNode";
import { FileUploadNode } from "@/components/nodes/FileUploadNode";
import { computeGeneratorHandleSpecs } from "@/utils/generatorHandles";

export interface OverlayNodeHandleSpec {
  id?: string;
  type: "source" | "target";
  position: Position;
  className: string;
  top?: CSSProperties["top"];
  label?: string;
  labelClassName?: string;
  title?: string;
  isConnectable?: boolean;
  showMarker?: boolean;
}

export interface OverlayNodeRenderProps {
  id: string;
  type: string;
  data: Record<string, unknown>;
  selected: boolean;
  hovered: boolean;
}

export interface OverlayNodeDescriptor {
  type: string;
  size: {
    width: number;
    height: number;
  };
  handles: OverlayNodeHandleSpec[];
  render: ComponentType<OverlayNodeRenderProps>;
  showHandleMarkers?: boolean;
}

type GenericNodeProps = NodeProps<Node<Record<string, unknown>>>;
type OverlayCompatibleNodeComponent = ComponentType<any>;

function createOverlayNodeProps(props: OverlayNodeRenderProps): GenericNodeProps {
  return {
    id: props.id,
    type: props.type,
    data: {
      ...props.data,
      __renderOverlay: true,
    },
    selected: props.selected || props.hovered,
    dragging: false,
    zIndex: 0,
    selectable: false,
    draggable: false,
    deletable: true,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
}

function nodeRenderer(Component: OverlayCompatibleNodeComponent): ComponentType<OverlayNodeRenderProps> {
  return function OverlayNodeRenderer(props) {
    return <Component {...createOverlayNodeProps(props)} />;
  };
}

const llmContentInputTop = 116;

function sourceHandle(id: string, className: string, title?: string): OverlayNodeHandleSpec {
  return {
    id,
    type: "source",
    position: Position.Right,
    top: "50%",
    className: `!w-3 !h-3 ${className} !border-2 !border-white`,
    title,
  };
}

// imageGeneratorNode 的 handle 列表由 computeGeneratorHandleSpecs 动态计算（依赖节点连线），
// 此处仅提供静态默认值（提示词 + 一个空闲参考图槽位 + 输出），供描述符类型与非动态场景使用。
function imageGeneratorHandles(): OverlayNodeHandleSpec[] {
  return computeGeneratorHandleSpecs("__default__", [], []);
}

const llmContentUnifiedInputHandle: OverlayNodeHandleSpec = {
  id: "input",
  type: "target",
  position: Position.Left,
  top: llmContentInputTop,
  className: "canvas-node-minimal-handle canvas-node-minimal-handle-input",
  title: "输入",
};

const llmContentLegacyPromptHandle: OverlayNodeHandleSpec = {
  id: "input-prompt",
  type: "target",
  position: Position.Left,
  top: llmContentInputTop,
  className: "canvas-node-legacy-handle",
  isConnectable: false,
  showMarker: false,
};

const llmContentLegacyImageHandle: OverlayNodeHandleSpec = {
  id: "input-image",
  type: "target",
  position: Position.Left,
  top: llmContentInputTop,
  className: "canvas-node-legacy-handle",
  isConnectable: false,
  showMarker: false,
};

const llmContentLegacyFileHandle: OverlayNodeHandleSpec = {
  id: "input-file",
  type: "target",
  position: Position.Left,
  top: llmContentInputTop,
  className: "canvas-node-legacy-handle",
  isConnectable: false,
  showMarker: false,
};

function unifiedLLMContentHandles(): OverlayNodeHandleSpec[] {
  return [
    llmContentUnifiedInputHandle,
    llmContentLegacyPromptHandle,
    llmContentLegacyImageHandle,
    llmContentLegacyFileHandle,
    {
      id: "output-prompt",
      type: "source",
      position: Position.Right,
      top: llmContentInputTop,
      className: "canvas-node-minimal-handle canvas-node-minimal-handle-output",
      title: "输出内容",
    },
  ];
}

export const overlayNodeDescriptors: Record<string, OverlayNodeDescriptor> = {
  promptNode: {
    type: "promptNode",
    size: { width: 300, height: 155 },
    handles: [sourceHandle("output-prompt", "!bg-blue-500")],
    render: nodeRenderer(PromptNode),
  },
  imageInputNode: {
    type: "imageInputNode",
    size: { width: 200, height: 176 },
    handles: [
      {
        // 目标连接点：允许 生图节点输出图 / 其他图片来源 连入图片输入节点
        // （右键"输出图转为图片输入"、"以此图继续生成"、画廊/输出图拖拽的自动连线都指向它）
        id: "input-image",
        type: "target",
        position: Position.Left,
        top: "50%",
        className: "!w-3 !h-3 !bg-green-500 !border-2 !border-white",
        label: "图片",
        labelClassName: "-left-6",
      },
      sourceHandle("output-image", "!bg-green-500"),
    ],
    render: nodeRenderer(ImageInputNode),
  },
  fileUploadNode: {
    type: "fileUploadNode",
    size: { width: 220, height: 162 },
    handles: [sourceHandle("output-file", "!bg-orange-500")],
    render: nodeRenderer(FileUploadNode),
  },
  imageGeneratorNode: {
    type: "imageGeneratorNode",
    // 高度含两行内联控制行（模型选择器 + 协议参数行，参数行可能换行）
    size: { width: 360, height: 680 },
    handles: imageGeneratorHandles(),
    render: nodeRenderer(ImageGeneratorNode),
  },
  llmContentNode: {
    type: "llmContentNode",
    size: { width: 360, height: 430 },
    handles: unifiedLLMContentHandles(),
    render: nodeRenderer(LLMContentNode),
  },
};

export const overlayNodeTypes = Object.keys(overlayNodeDescriptors);

export function getOverlayNodeDescriptor(type?: string | null) {
  return type ? overlayNodeDescriptors[type] : undefined;
}

/**
 * 获取节点应渲染的 handle 列表。
 * imageGeneratorNode 的参考图槽位是动态的（每条参考图连线独占一个槽位 id，
 * 且始终额外渲染一个空闲槽位），依赖该节点的连线与来源节点类型；
 * 其他节点类型保持静态描述符。
 */
export function getNodeOverlayHandles(
  nodeId: string,
  type: string | undefined,
  edges: Edge[],
  nodes: Node[]
): OverlayNodeHandleSpec[] {
  if (type === "imageGeneratorNode") {
    return computeGeneratorHandleSpecs(nodeId, edges, nodes);
  }
  return getOverlayNodeDescriptor(type)?.handles ?? [];
}
