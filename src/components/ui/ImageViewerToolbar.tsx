import { Download, Loader2, X, ZoomIn, ZoomOut } from "lucide-react";

interface ImageViewerToolbarProps {
  /** 当前缩放比例（0.5 - 3） */
  scale: number;
  /** 下载进行中（按钮禁用并显示加载图标） */
  isDownloading: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onDownload: () => void;
  onClose: () => void;
}

/**
 * 图片查看器工具栏（ImagePreviewModal / ImageDetailModal 共用）
 * 按钮使用 nc-icon-btn-viewer：深色遮罩上的白色半透明玻璃质感
 */
export function ImageViewerToolbar({
  scale,
  isDownloading,
  onZoomIn,
  onZoomOut,
  onDownload,
  onClose,
}: ImageViewerToolbarProps) {
  return (
    <>
      <button
        type="button"
        className="nc-icon-btn-viewer"
        onClick={onZoomOut}
        aria-label="缩小"
      >
        <ZoomOut className="w-4 h-4" />
      </button>
      <span className="text-white text-sm min-w-[60px] text-center tabular-nums">
        {Math.round(scale * 100)}%
      </span>
      <button
        type="button"
        className="nc-icon-btn-viewer"
        onClick={onZoomIn}
        aria-label="放大"
      >
        <ZoomIn className="w-4 h-4" />
      </button>
      <div className="w-px h-6 bg-white/20 mx-1" />
      <button
        type="button"
        className="nc-icon-btn-viewer"
        onClick={onDownload}
        disabled={isDownloading}
        title="下载图片"
        aria-label="下载图片"
      >
        {isDownloading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Download className="w-4 h-4" />
        )}
      </button>
      <button
        type="button"
        className="nc-icon-btn-viewer"
        onClick={onClose}
        aria-label="关闭"
      >
        <X className="w-4 h-4" />
      </button>
    </>
  );
}
