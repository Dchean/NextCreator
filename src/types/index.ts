import type { Node, Edge } from "@xyflow/react";
import type { ImageGeneratorNodeData } from "@/components/nodes/imageGeneratorConfig";
import type { LLMContentNodeData } from "@/components/nodes/llmContentConfig";

// 详细错误信息结构
export interface ErrorDetails {
  name?: string;           // 错误名称（如 API_Error, NetworkError）
  message: string;         // 错误消息
  stack?: string;          // 堆栈信息
  cause?: unknown;         // 错误原因
  statusCode?: number;     // HTTP 状态码
  requestUrl?: string;     // 请求路径
  requestBody?: unknown;   // 请求体
  responseHeaders?: Record<string, string>;  // 响应头
  responseBody?: unknown;  // 响应内容
  timestamp?: string;      // 错误发生时间
  nodeId?: string;         // 发生错误的节点 ID
  model?: string;          // 使用的模型
  provider?: string;       // 使用的供应商
}

// 模型类型（图片生成）- 支持自定义模型名称
export type ModelType = string;

// LLM 模型类型（支持自定义模型名称）
export type LLMModelType = string;

// 图片生成参数
export interface ImageGenerationParams {
  prompt: string;
  model: ModelType;
  aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3" | "5:4" | "4:5" | "21:9" | "1:4" | "4:1" | "1:8" | "8:1";
  imageSize?: "512" | "1K" | "2K" | "4K";
  responseModalities?: ("TEXT" | "IMAGE")[];
}

// 图片编辑参数
export interface ImageEditParams extends ImageGenerationParams {
  inputImages?: string[]; // base64 编码的图片数组（支持多图输入）
}

// API 响应
export interface GenerationResponse {
  imageData?: string; // base64 编码的图片数据
  text?: string;
  error?: string;
  errorDetails?: ErrorDetails;  // 详细错误信息
}

// 节点数据类型 - 添加索引签名以满足 React Flow 的 Record<string, unknown> 约束
export interface PromptNodeData {
  [key: string]: unknown;
  label: string;
  prompt: string;
}

export type { ImageGeneratorNodeData } from "@/components/nodes/imageGeneratorConfig";

export interface ImageInputNodeData {
  [key: string]: unknown;
  label: string;
  imageData?: string;
  fileName?: string;
  imagePath?: string;
  maskImageData?: string;
  maskImagePath?: string;
  hasMask?: boolean;
}

export interface TextOutputNodeData {
  [key: string]: unknown;
  label: string;
  text?: string;
}

// LLM 内容生成节点数据
export type { LLMContentNodeData } from "@/components/nodes/llmContentConfig";

// 文件上传节点数据
export interface FileUploadNodeData {
  [key: string]: unknown;
  label: string;
  fileData?: string;      // base64 编码的文件内容
  fileName?: string;      // 文件名
  mimeType?: string;      // MIME 类型
  fileSize?: number;      // 文件大小（字节）
}

// 节点类型联合
export type CustomNodeData =
  | PromptNodeData
  | ImageGeneratorNodeData
  | ImageInputNodeData
  | TextOutputNodeData
  | LLMContentNodeData
  | FileUploadNodeData;

// 自定义节点类型
export type CustomNode = Node<CustomNodeData>;
export type CustomEdge = Edge;

// 节点分类定义
export interface NodeCategory {
  id: string;
  name: string;
  icon: string;
  nodes: NodeDefinition[];
}

export interface NodeDefinition {
  type: string;
  label: string;
  description: string;
  icon: string;
  defaultData: Record<string, unknown>;
  inputs?: string[];
  outputs?: string[];
}

// 供应商协议类型
export type ProviderProtocol = 'openai' | 'openaiResponses' | 'google' | 'claude';

// 供应商配置
export interface Provider {
  id: string;           // 唯一标识 (uuid)
  name: string;         // 供应商名称
  apiKey: string;       // API Key
  baseUrl: string;      // Base URL（不包含版本路径如 /v1beta）
  protocol: ProviderProtocol;  // API 协议类型
}

// 节点类型到供应商的映射
export interface NodeProviderMapping {
  imageGeneratorNB2?: string;   // Gemini generateContent 图片协议使用的供应商 ID
  gptImageGenerator?: string;   // OpenAI Images API 图片协议使用的供应商 ID
  llmContent?: string;          // LLM 内容生成节点使用的供应商 ID
}

// 节点类型允许的协议映射
export const NODE_ALLOWED_PROTOCOLS: Record<keyof NodeProviderMapping, ProviderProtocol[]> = {
  imageGeneratorNB2: ["google", "openai", "openaiResponses"],
  gptImageGenerator: ["openai"],
  llmContent: ["google", "openai", "openaiResponses", "claude"],
};

// 应用设置
export interface AppSettings {
  providers: Provider[];              // 供应商列表
  nodeProviders: NodeProviderMapping; // 节点类型 -> 供应商映射
  theme: "light" | "dark" | "system";
  // 模型可见性（设置页勾选）：黑名单语义，未列出的模型默认可用。
  // image = 生图节点可选模型，llm = LLM 节点可选模型，两组相互独立。
  disabledModels: { image: string[]; llm: string[] };
}

// Store 状态
export interface FlowState {
  nodes: CustomNode[];
  edges: CustomEdge[];
  selectedNodeId: string | null;
}

export interface SettingsState {
  settings: AppSettings;
  isSettingsOpen: boolean;
}

// 提示词相关类型（从 promptConfig.ts 重新导出）
export type { PromptCategory, PromptItem } from "@/config/promptConfig";
