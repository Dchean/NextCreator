import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Copy,
  Check,
  ExternalLink,
  Tag,
  FileText,
  Image as ImageIcon,
  Zap,
  Sparkles,
  ImagePlus,
  RectangleHorizontal,
  Heart,
} from "lucide-react";
import { useModal, getModalAnimationClasses } from "@/hooks/useModal";
import type { PromptItem } from "@/config/promptConfig";
import { ImagePreviewModal } from "@/components/ui/ImagePreviewModal";
import { useFavoritePromptStore } from "@/stores/favoritePromptStore";

interface PromptPreviewModalProps {
  prompt: PromptItem | null;
  isOpen: boolean;
  onClose: () => void;
}

export function PromptPreviewModal({ prompt, isOpen, onClose }: PromptPreviewModalProps) {
  const [copied, setCopied] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [isImagePreviewOpen, setIsImagePreviewOpen] = useState(false);

  // 收藏功能
  const { isFavorite, toggleFavorite } = useFavoritePromptStore();
  const isCurrentFavorite = prompt ? isFavorite(prompt.id) : false;

  // 统一 Modal 交互（ESC 关闭、背景点击、过渡动画）
  const { isVisible, isClosing, handleClose, handleBackdropClick } = useModal({
    isOpen,
    onClose,
  });

  const { contentClasses } = getModalAnimationClasses(isVisible, isClosing);

  // 打开时重置媒体状态
  useEffect(() => {
    if (isOpen) {
      setImageLoaded(false);
      setImageError(false);
      setIsImagePreviewOpen(false); // 重置图片预览状态
    }
  }, [isOpen]);

  // 复制提示词
  const copyToClipboard = useCallback(async () => {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("复制失败:", err);
    }
  }, [prompt]);

  if (!isOpen || !prompt) return null;

  return createPortal(
    <div
      className={`nc-modal-backdrop p-4 ${isVisible && !isClosing ? "nc-modal-backdrop-open" : ""}`}
      onClick={handleBackdropClick}
    >
      {/* Modal 内容 */}
      <div
        className={`
          nc-modal w-full max-w-2xl max-h-[90vh] flex flex-col
          transition-all duration-200 ease-out
          ${contentClasses}
        `}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部（含标签，底部边框由 .nc-modal-header 提供） */}
        <div
          className="nc-modal-header"
          style={{ alignItems: "flex-start" }}
        >
          <div className="flex-1 min-w-0">
            <h2 className="text-[16px] font-bold truncate">{prompt.title}</h2>
            <p className="text-sm text-base-content/60 truncate">{prompt.titleEn}</p>

            {/* 标签 */}
            <div className="flex flex-wrap gap-1.5 mt-3">
              {prompt.tags.map((tag) => (
                <span key={tag} className="nc-chip nc-chip-accent">
                  <Tag className="w-3 h-3" />
                  {tag}
                </span>
              ))}
            </div>
          </div>
          <button
            type="button"
            className="nc-icon-btn flex-shrink-0"
            onClick={handleClose}
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 可滚动内容区域 */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* 描述 */}
          <div>
            <p className="text-sm text-base-content/80">{prompt.description}</p>
          </div>

          {/* 模板配置信息 */}
          <div className="flex flex-wrap items-center gap-2">
            {/* 模型类型 */}
            <span
              className={`nc-chip nc-chip-lg ${
                prompt.nodeTemplate.generatorType === "pro"
                  ? "nc-chip-neutral"
                  : prompt.nodeTemplate.generatorType === "nb2"
                    ? "nc-chip-accent"
                    : "nc-chip-warning"
              }`}
            >
              {prompt.nodeTemplate.generatorType === "pro" ? (
                <Sparkles className="w-3.5 h-3.5" />
              ) : prompt.nodeTemplate.generatorType === "nb2" ? (
                <Sparkles className="w-3.5 h-3.5" />
              ) : (
                <Zap className="w-3.5 h-3.5" />
              )}
              {prompt.nodeTemplate.generatorType === "pro"
                ? "NanoBanana Pro"
                : prompt.nodeTemplate.generatorType === "nb2"
                  ? "NanoBanana2"
                  : "NanoBanana"}
            </span>

            {/* 是否需要图片输入 */}
            <span
              className={`nc-chip nc-chip-lg ${
                prompt.nodeTemplate.requiresImageInput ? "nc-chip-accent" : "nc-chip-neutral"
              }`}
            >
              <ImagePlus className="w-3.5 h-3.5" />
              {prompt.nodeTemplate.requiresImageInput ? "需要图片输入" : "无需图片输入"}
            </span>

            {/* 宽高比 */}
            <span className="nc-chip nc-chip-lg nc-chip-neutral">
              <RectangleHorizontal className="w-3.5 h-3.5" />
              {prompt.nodeTemplate.aspectRatio}
            </span>
          </div>

          {/* 预览图 */}
          {prompt.previewImage && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-base-content/70">
                <ImageIcon className="w-4 h-4" />
                <span>效果预览</span>
              </div>
              <div className="relative rounded-xl overflow-hidden bg-base-200 border border-base-300">
                {!imageLoaded && !imageError && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="loading loading-spinner loading-md text-primary" />
                  </div>
                )}
                {imageError ? (
                  <div className="flex items-center justify-center py-12 text-base-content/40">
                    <div className="text-center">
                      <ImageIcon className="w-8 h-8 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">图片加载失败</p>
                    </div>
                  </div>
                ) : (
                  <img
                    src={prompt.previewImage}
                    alt={prompt.title}
                    className={`w-full h-auto max-h-80 object-contain transition-opacity duration-300 cursor-pointer hover:opacity-90 ${
                      imageLoaded ? "opacity-100" : "opacity-0"
                    }`}
                    onLoad={() => setImageLoaded(true)}
                    onError={() => setImageError(true)}
                    onClick={() => setIsImagePreviewOpen(true)}
                    title="点击查看大图"
                  />
                )}
              </div>
            </div>
          )}

          {/* 提示词内容 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-base-content/70">
                <FileText className="w-4 h-4" />
                <span>提示词内容</span>
              </div>
              <button
                className={`btn btn-ghost btn-xs gap-1 ${copied ? "text-success" : ""}`}
                onClick={copyToClipboard}
              >
                {copied ? (
                  <>
                    <Check className="w-3 h-3" />
                    已复制
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    复制
                  </>
                )}
              </button>
            </div>
            <div className="nc-soft-panel">
              <pre className="text-sm text-base-content/80 whitespace-pre-wrap break-words font-mono leading-relaxed max-h-60 overflow-y-auto">
                {prompt.prompt}
              </pre>
            </div>
          </div>

          {/* 来源 */}
          {prompt.source && (
            <div className="flex items-center gap-2 text-xs text-base-content/50 pt-2 border-t border-base-200">
              <ExternalLink className="w-3 h-3" />
              <span>来源: {prompt.source}</span>
            </div>
          )}
        </div>

        {/* 底部操作区 */}
        <div className="nc-modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={handleClose}>
            关闭
          </button>
          {/* 收藏按钮 */}
          <button
            className={`btn btn-sm gap-1.5 ${
              isCurrentFavorite
                ? "btn-error text-white"
                : "btn-ghost"
            }`}
            onClick={() => prompt && toggleFavorite(prompt.id)}
          >
            <Heart
              className={`w-4 h-4 ${isCurrentFavorite ? "fill-current" : ""}`}
            />
            {isCurrentFavorite ? "已收藏" : "收藏"}
          </button>
          <button
            className={`btn btn-primary btn-sm gap-1.5 ${copied ? "btn-success" : ""}`}
            onClick={copyToClipboard}
          >
            {copied ? (
              <>
                <Check className="w-4 h-4" />
                已复制到剪贴板
              </>
            ) : (
              <>
                <Copy className="w-4 h-4" />
                复制提示词
              </>
            )}
          </button>
        </div>
      </div>

      {/* 图片预览 Modal */}
      {isImagePreviewOpen && prompt.previewImage && (
        <ImagePreviewModal
          imageData={
            prompt.previewImage.startsWith("data:image")
              ? prompt.previewImage.replace(/^data:image\/\w+;base64,/, "")
              : undefined
          }
          imagePath={
            prompt.previewImage.startsWith("http://") || prompt.previewImage.startsWith("https://")
              ? prompt.previewImage
              : !prompt.previewImage.startsWith("data:")
                ? prompt.previewImage
                : undefined
          }
          onClose={() => setIsImagePreviewOpen(false)}
          fileName={`${prompt.title}.png`}
        />
      )}
    </div>,
    document.body
  );
}
