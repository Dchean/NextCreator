import type { NodePromptSource } from "@/hooks/useNodeConnectionStatus";

/** 节点信息行中最多直接展示的已连接提示词来源数量，超出的折叠为 +N */
const MAX_VISIBLE_PROMPT_SOURCES = 2;

interface PromptSourceRowProps {
  /** 节点内提示词是否非空（执行时优先使用） */
  hasInlinePrompt: boolean;
  /** 节点内提示词的字符数 */
  inlineCharCount: number;
  /** 已连接的提示词来源（包含内容为空的来源） */
  promptSources: NodePromptSource[];
}

/**
 * 节点卡片上的"生效来源"行：只展示提示词来自哪里（来源名 + 字数），不展示提示词内容。
 * 节点内提示词与连接的提示词同时存在时，执行时仅使用节点内提示词（见 buildImageGeneratorPrompt），
 * 因此追加"将被忽略"警告角标。
 */
export function PromptSourceRow({ hasInlinePrompt, inlineCharCount, promptSources }: PromptSourceRowProps) {
  const hasConnectedSources = promptSources.length > 0;
  const hasConnectedContent = promptSources.some((source) => source.charCount > 0);
  const visibleSources = promptSources.slice(0, MAX_VISIBLE_PROMPT_SOURCES);
  const overflowCount = promptSources.length - visibleSources.length;
  const showConflictWarning = hasInlinePrompt && hasConnectedContent;

  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="nc-node-row-label w-12 pt-1">提示词:</span>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {hasInlinePrompt && (
          <span className="nc-image-prompt-source-chip nc-image-prompt-source-chip-accent">
            {`节点内提示词 · ${inlineCharCount} 字`}
          </span>
        )}
        {visibleSources.map((source) => (
          <span key={source.id} className="nc-image-prompt-source-chip">
            {`⤳ ${source.label} · ${source.charCount > 0 ? `${source.charCount} 字` : "空"}`}
          </span>
        ))}
        {overflowCount > 0 && (
          <span className="nc-image-prompt-source-chip">{`+${overflowCount}`}</span>
        )}
        {showConflictWarning && (
          <span className="nc-image-prompt-source-chip nc-image-prompt-source-chip-warn">
            {`已连接 ${promptSources.length} 个 · 将被忽略`}
          </span>
        )}
        {!hasInlinePrompt && !hasConnectedSources && (
          <span className="nc-image-prompt-source-chip nc-image-prompt-source-chip-empty">
            未设置提示词
          </span>
        )}
      </div>
    </div>
  );
}
