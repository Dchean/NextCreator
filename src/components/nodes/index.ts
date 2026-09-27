export { PromptNode } from "./PromptNode";
export { ImageGeneratorNode } from "./ImageGeneratorNode";
export { ImageInputNode } from "./ImageInputNode";
export { LLMContentNode } from "./LLMContentNode";
export { FileUploadNode } from "./FileUploadNode";

import { InteractionNodeShell } from "@/components/canvas/InteractionNodeShell";

// 节点类型映射
export const nodeTypes = {
  promptNode: InteractionNodeShell,
  imageGeneratorNode: InteractionNodeShell,
  imageInputNode: InteractionNodeShell,
  llmContentNode: InteractionNodeShell,
  fileUploadNode: InteractionNodeShell,
};
