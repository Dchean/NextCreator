import { useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useModal } from "@/hooks/useModal";
import { ImageViewerToolbar } from "@/components/ui/ImageViewerToolbar";
import { getImageUrl, readImage, readImageMetadata, formatFileSize } from "@/services/fileStorageService";
import { toast } from "@/stores/toastStore";

interface ImageInfo {
  width: number;
  height: number;
  ratio: string;        // 简化比例如 4:3
  decimalRatio: string;  // 小数比例如 1.24:1
  fileSize?: string;
  createdAt?: string;
}

/** 计算最简整数比例 */
function computeSimpleRatio(w: number, h: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(w, h);
  const rw = w / d;
  const rh = h / d;
  if (rw <= 21 && rh <= 21) return `${rw}:${rh}`;
  // 尝试近似匹配常见比例
  const known = [
    [1, 1], [4, 3], [3, 4], [16, 9], [9, 16], [3, 2], [2, 3],
    [5, 4], [4, 5], [21, 9], [1, 4], [4, 1], [1, 8], [8, 1],
  ];
  const actual = w / h;
  for (const [kw, kh] of known) {
    if (Math.abs(actual - kw / kh) < 0.02) return `${kw}:${kh}`;
  }
  return `${rw}:${rh}`;
}

/** 小数比例 */
function computeDecimalRatio(w: number, h: number): string {
  if (w >= h) return `${(w / h).toFixed(2)}:1`;
  return `1:${(h / w).toFixed(2)}`;
}

function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface ImagePreviewModalProps {
  imageData?: string;      // base64 数据（可选）
  imagePath?: string;      // 文件路径（可选）
  onClose: () => void;
  fileName?: string;
}

export function ImagePreviewModal({ imageData, imagePath, onClose, fileName }: ImagePreviewModalProps) {
  const [scale, setScale] = useState(1);
  const [isDownloading, setIsDownloading] = useState(false);
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // 统一 Modal 交互（ESC 关闭、过渡动画）
  const { isVisible, isClosing, handleClose } = useModal({
    isOpen: true,
    onClose,
  });

  // 获取图片 URL
  const imageUrl = imagePath
    ? (imagePath.startsWith("http://") || imagePath.startsWith("https://"))
      ? imagePath  // 外部 URL 直接使用
      : getImageUrl(imagePath)  // 本地路径使用 getImageUrl
    : imageData
    ? `data:image/png;base64,${imageData}`
    : "";

  // 图片加载后获取信息
  const handleImageLoad = useCallback(async () => {
    const img = imgRef.current;
    if (!img) return;

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const ratio = computeSimpleRatio(w, h);
    const decimalRatio = computeDecimalRatio(w, h);

    let fileSize: string | undefined;
    let createdAt: string | undefined;

    if (imagePath && !imagePath.startsWith("http")) {
      // 从文件系统获取真实文件大小
      try {
        const { stat } = await import("@tauri-apps/plugin-fs");
        const fileStat = await stat(imagePath);
        if (fileStat.size != null) {
          fileSize = formatFileSize(fileStat.size);
        }
      } catch { /* ignore */ }

      // 从元数据获取创建时间
      try {
        const metadata = await readImageMetadata(imagePath);
        if (metadata?.created_at) {
          createdAt = formatDateTime(metadata.created_at);
        }
      } catch { /* ignore */ }
    }

    // base64 fallback for file size
    if (!fileSize && imageData) {
      const bytes = Math.ceil(imageData.length * 3 / 4);
      fileSize = formatFileSize(bytes);
    }

    setImageInfo({ width: w, height: h, ratio, decimalRatio, fileSize, createdAt });
  }, [imageData, imagePath]);

  // 关闭时先播放退出动画（useModal）；阻止冒泡避免触发父级 Modal 的关闭
  const handleBackgroundClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止事件冒泡到父级 Modal
    handleClose();
  }, [handleClose]);

  const handleDownload = useCallback(async () => {
    if (isDownloading) return;

    setIsDownloading(true);

    try {
      // 获取 base64 数据
      let base64Data: string;

      if (imageData) {
        base64Data = imageData;
      } else if (imagePath) {
        // 从文件路径读取 base64 数据
        base64Data = await readImage(imagePath);
      } else {
        toast.error("没有可下载的图片数据");
        return;
      }

      const defaultFileName = fileName || `next-creator-${Date.now()}.png`;

      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");

      const filePath = await save({
        defaultPath: defaultFileName,
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });

      if (filePath) {
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        await writeFile(filePath, bytes);
        toast.success(`图片已保存到: ${filePath.split("/").pop()}`);
      }
    } catch (error) {
      console.error("下载失败:", error);
      toast.error(`下载失败: ${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setIsDownloading(false);
    }
  }, [imageData, imagePath, fileName, isDownloading]);

  const handleZoomIn = () => setScale((s) => Math.min(s + 0.25, 3));
  const handleZoomOut = () => setScale((s) => Math.max(s - 0.25, 0.5));

  // 使用 Portal 渲染到 body，避免被节点的 transform 影响
  return createPortal(
    <div
      className={`
        nc-modal-backdrop nc-modal-backdrop-deep
        transition-all duration-200 ease-out
        ${isVisible && !isClosing ? "opacity-100" : "opacity-0"}
      `}
      onClick={handleBackgroundClick}
    >
      {/* 图片容器 - 使用 object-contain 确保完整显示无滚动条 */}
      {/* 容器本身不拦截点击，让点击穿透到背景层触发关闭 */}
      <div
        className={`
          relative w-full h-full flex items-center justify-center p-12 pointer-events-none
          transition-all duration-200 ease-out
          ${isVisible && !isClosing
            ? "opacity-100 scale-100"
            : "opacity-0 scale-95"
          }
        `}
      >
        <img
          ref={imgRef}
          src={imageUrl}
          alt="Preview"
          className="max-w-full max-h-full object-contain transition-transform duration-200 pointer-events-auto"
          style={{ transform: `scale(${scale})`, transformOrigin: "center" }}
          onLoad={handleImageLoad}
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      {/* 工具栏 - 置于顶层 */}
      <div
        className={`
          absolute top-4 right-4 z-10 flex items-center gap-2 pointer-events-auto
          transition-all duration-200 ease-out
          ${isVisible && !isClosing ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"}
        `}
        onClick={(e) => e.stopPropagation()}
      >
        <ImageViewerToolbar
          scale={scale}
          isDownloading={isDownloading}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onDownload={() => void handleDownload()}
          onClose={handleClose}
        />
      </div>

      {/* 图片信息 - 固定在窗口右下角 */}
      {imageInfo && (
        <div
          className={`
            absolute bottom-4 right-4 z-10 flex items-center gap-2.5
            bg-black/60 backdrop-blur-sm text-white/80 text-xs
            px-3 py-1.5 rounded-lg select-none pointer-events-none
            transition-all duration-300 ease-out
            ${isVisible && !isClosing ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"}
          `}
        >
          <span>{imageInfo.width} x {imageInfo.height}</span>
          <span className="w-px h-3 bg-white/30" />
          <span>{imageInfo.ratio}</span>
          {imageInfo.ratio !== imageInfo.decimalRatio && (
            <span className="text-white/50">({imageInfo.decimalRatio})</span>
          )}
          {imageInfo.fileSize && (
            <>
              <span className="w-px h-3 bg-white/30" />
              <span>{imageInfo.fileSize}</span>
            </>
          )}
          {imageInfo.createdAt && (
            <>
              <span className="w-px h-3 bg-white/30" />
              <span>{imageInfo.createdAt}</span>
            </>
          )}
        </div>
      )}

      {/* 提示 */}
      <div
        className={`
          nc-overlay-hint
          transition-all duration-200 ease-out
          ${isVisible && !isClosing ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"}
        `}
      >
        点击背景或按 ESC 关闭
      </div>
    </div>,
    document.body
  );
}
