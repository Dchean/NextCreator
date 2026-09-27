import {
  MessageSquare,
  Sparkles,
  ImagePlus,
  MessageSquareText,
  FileUp,
} from "lucide-react";
import type { NodeCategory } from "@/types";
import { getDefaultImageGeneratorData } from "@/components/nodes/imageGeneratorConfig";
import { getDefaultLLMContentData } from "@/components/nodes/llmContentConfig";

// 节点分类定义 - 统一配置
export const nodeCategories: NodeCategory[] = [
  {
    id: "input",
    name: "输入",
    icon: "input",
    nodes: [
      {
        type: "promptNode",
        label: "提示词",
        description: "输入文本提示词用于图片生成",
        icon: "MessageSquare",
        defaultData: { label: "提示词", prompt: "" },
        outputs: ["prompt"],
      },
      {
        type: "imageInputNode",
        label: "图片输入",
        description: "上传图片用于图片编辑",
        icon: "ImagePlus",
        defaultData: { label: "图片输入" },
        inputs: ["image"],
        outputs: ["image"],
      },
      {
        type: "fileUploadNode",
        label: "文件上传",
        description: "上传文件供 LLM 解析（支持图片/PDF/音频/视频）",
        icon: "FileUp",
        defaultData: { label: "文件上传" },
        outputs: ["file"],
      },
    ],
  },
  {
    id: "drawing",
    name: "绘图",
    icon: "drawing",
    nodes: [
      {
        type: "imageGeneratorNode",
        label: "绘图生成",
        description: "按接口规范选择 Gemini generateContent 或 OpenAI Images API，再选择模型",
        icon: "Sparkles",
        defaultData: getDefaultImageGeneratorData(),
        inputs: ["prompt", "image"],
        outputs: ["image"],
      },
    ],
  },
  {
    id: "text",
    name: "文本",
    icon: "text",
    nodes: [
      {
        type: "llmContentNode",
        label: "LLM 内容生成",
        description: "按接口规范选择 OpenAI、Gemini 或 Claude 内容协议，再选择模型",
        icon: "MessageSquareText",
        defaultData: getDefaultLLMContentData(),
        inputs: ["prompt", "image", "file"],
        outputs: ["prompt"],
      },
    ],
  },
];

// 图标映射
export const nodeIconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  MessageSquare,
  Sparkles,
  ImagePlus,
  MessageSquareText,
  FileUp,
};

// 图标颜色映射
export const nodeIconColors: Record<string, string> = {
  MessageSquare: "bg-[var(--nc-blue-soft)] text-[var(--nc-blue)]",
  Sparkles: "bg-purple-500/10 text-purple-500",
  ImagePlus: "bg-[color-mix(in_srgb,var(--nc-success)_10%,transparent)] text-[var(--nc-success)]",
  MessageSquareText: "bg-teal-500/10 text-teal-500",
  FileUp: "bg-orange-500/10 text-orange-500",
};
