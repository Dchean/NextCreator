import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  HardDrive,
  Image,
  Trash2,
  RefreshCw,
  FolderOpen,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Eraser,
} from "lucide-react";
import { useModal, getModalAnimationClasses } from "@/hooks/useModal";
import { useStorageManagementStore } from "@/stores/storageManagementStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { formatFileSize, getImageUrl, type ImageInfoWithMetadata } from "@/services/fileStorageService";
import { LoadingIndicator } from "@/components/ui/LoadingIndicator";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ImageDetailModal } from "@/components/ui/ImageDetailModal";

export function StorageManagementModal() {
  const {
    isOpen,
    isLoading,
    fileStats,
    storagePath,
    storageConfig,
    expandedFileCanvases,
    canvasImages,
    error,
    closeModal,
    refreshStats,
    handleClearCache,
    handleClearAllImages,
    handleClearCanvasImages,
    handleDeleteImage,
    handleCleanupUnreferenced,
    toggleFileCanvasExpanded,
    loadCanvasImages,
  } = useStorageManagementStore();

  const { canvases } = useCanvasStore();

  // 统一 Modal 交互（ESC 关闭、背景点击、过渡动画）
  const { isVisible, isClosing, handleClose, handleBackdropClick } = useModal({
    isOpen,
    onClose: closeModal,
  });

  const { contentClasses } = getModalAnimationClasses(isVisible, isClosing);

  // 删除确认状态
  const [deleteConfirm, setDeleteConfirm] = useState<{
    type: "image" | "canvas" | "allImages" | "unreferenced";
    path?: string;
    filename?: string;
    canvasId?: string;
    canvasName?: string;
  } | null>(null);

  // 图片详情预览状态
  const [selectedImage, setSelectedImage] = useState<ImageInfoWithMetadata | null>(null);

  // 搜索状态
  const [searchQuery, setSearchQuery] = useState("");

  // 当用户输入搜索关键词时，自动加载所有画布的图片数据
  useEffect(() => {
    if (!searchQuery.trim() || !fileStats) return;

    // 加载所有未加载的画布图片
    const loadAllCanvasImages = async () => {
      const canvasIds = fileStats.images_by_canvas.map(c => c.canvas_id);
      const unloadedCanvasIds = canvasIds.filter(id => !canvasImages.has(id));

      // 并行加载所有未加载的画布图片
      await Promise.all(
        unloadedCanvasIds.map(canvasId => loadCanvasImages(canvasId))
      );
    };

    loadAllCanvasImages();
  }, [searchQuery, fileStats, canvasImages, loadCanvasImages]);

  if (!isOpen) return null;

  // 获取画布名称
  const getCanvasName = (canvasId: string): string => {
    const canvas = canvases.find((c) => c.id === canvasId);
    return canvas?.name || `画布 ${canvasId.slice(0, 8)}...`;
  };

  // 执行确认的删除操作
  const executeDelete = async () => {
    if (!deleteConfirm) return;

    const { type, path, canvasId } = deleteConfirm;
    setDeleteConfirm(null);

    switch (type) {
      case "image":
        if (path) await handleDeleteImage(path);
        break;
      case "canvas":
        if (canvasId) await handleClearCanvasImages(canvasId);
        break;
      case "allImages":
        await handleClearAllImages();
        break;
      case "unreferenced":
        await handleCleanupUnreferenced();
        break;
    }
  };

  // 确认清理所有图片
  const confirmClearAllImages = () => {
    setDeleteConfirm({ type: "allImages" });
  };

  // 确认清理未引用图片
  const confirmCleanupUnreferenced = () => {
    setDeleteConfirm({ type: "unreferenced" });
  };

  // 确认清理画布图片
  const confirmClearCanvasImages = (canvasId: string, canvasName: string) => {
    setDeleteConfirm({ type: "canvas", canvasId, canvasName });
  };

  // 确认删除单个图片
  const confirmDeleteImage = (e: React.MouseEvent, path: string, filename: string) => {
    e.stopPropagation();
    setDeleteConfirm({ type: "image", path, filename });
  };

  // 获取确认对话框的提示信息
  const getDeleteConfirmMessage = () => {
    if (!deleteConfirm) return "";
    switch (deleteConfirm.type) {
      case "image":
        return `确定要删除图片「${deleteConfirm.filename}」吗？此操作不可撤销。`;
      case "canvas":
        return `确定要删除画布「${deleteConfirm.canvasName}」的所有图片吗？此操作不可撤销。`;
      case "allImages":
        return "确定要删除所有存储的图片吗？此操作不可撤销，已保存在画布中的图片引用将失效。";
      case "unreferenced":
        return "将清理画布中已不再引用的历史副本/未引用图片，画布中正在使用的图片不受影响。此操作不可撤销。";
    }
  };

  // 渲染文件存储内容（桌面端）
  const renderFileStorage = () => {
    if (!fileStats) {
      return (
        <div className="flex items-center justify-center py-12 text-base-content/50">
          <p>无法获取文件存储信息</p>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {/* 搜索框 */}
        <div className="relative">
          <input
            type="text"
            placeholder="搜索提示词..."
            className="input input-sm w-full bg-base-200 border-base-300 focus:border-primary focus:outline-none pr-8"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              className="nc-icon-btn nc-icon-btn-xs absolute right-2 top-1/2 -translate-y-1/2"
              onClick={() => setSearchQuery("")}
              aria-label="清空搜索"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* 总览卡片 */}
        <div className="grid grid-cols-3 gap-3">
          <div className="nc-stat">
            <div className="nc-stat-label">
              <Image className="w-3.5 h-3.5" />
              <span>图片数量</span>
            </div>
            <p className="nc-stat-value">{fileStats.image_count}</p>
          </div>
          <div className="nc-stat">
            <div className="nc-stat-label">
              <HardDrive className="w-3.5 h-3.5" />
              <span>图片大小</span>
            </div>
            <p className="nc-stat-value">{formatFileSize(fileStats.total_size)}</p>
          </div>
          <div className="nc-stat">
            <div className="nc-stat-label">
              <FolderOpen className="w-3.5 h-3.5" />
              <span>缓存大小</span>
            </div>
            <p className="nc-stat-value">{formatFileSize(fileStats.cache_size)}</p>
          </div>
        </div>

        {/* 存储路径：展示当前生效的图片目录，应用数据目录作为辅助信息 */}
        {(storageConfig || storagePath) && (
          <div className="nc-soft-panel">
            <p className="nc-field-label">存储位置</p>
            <p className="text-sm font-mono break-all">
              {storageConfig?.images_dir || "读取中..."}
            </p>
            {storagePath && (
              <p className="mt-1 text-xs text-base-content/40 font-mono break-all">
                应用数据目录：{storagePath}
              </p>
            )}
          </div>
        )}

        {/* 按画布分组的存储 */}
        {fileStats.images_by_canvas.length > 0 && (
          <div>
            <h3 className="nc-section-title mb-2">按画布分组</h3>
            <div className="space-y-2">
              {fileStats.images_by_canvas.map((canvasStats) => {
                const canvasName = getCanvasName(canvasStats.canvas_id);
                const isExpanded = expandedFileCanvases.includes(canvasStats.canvas_id);
                const allImages = canvasImages.get(canvasStats.canvas_id) || [];

                // 根据搜索关键词过滤图片
                const filteredImages = !searchQuery.trim()
                  ? allImages
                  : allImages.filter((image) => {
                      const query = searchQuery.toLowerCase();
                      // 搜索提示词
                      const promptMatch = image.metadata?.prompt?.toLowerCase().includes(query);
                      // 搜索文件名
                      const filenameMatch = image.filename.toLowerCase().includes(query);
                      return promptMatch || filenameMatch;
                    });

                // 如果有搜索关键词且没有匹配结果，不显示这个画布分组
                if (searchQuery.trim() && filteredImages.length === 0) {
                  return null;
                }

                return (
                  <div
                    key={canvasStats.canvas_id}
                    className="border border-base-300 rounded-lg overflow-hidden"
                  >
                    {/* 画布头部 */}
                    <div
                      className="flex items-center justify-between bg-base-200 p-3 cursor-pointer hover:bg-base-300 transition-colors"
                      onClick={() => toggleFileCanvasExpanded(canvasStats.canvas_id)}
                    >
                      <div className="flex items-center gap-2">
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-base-content/60" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-base-content/60" />
                        )}
                        <div>
                          <p className="font-medium text-sm">{canvasName}</p>
                          <p className="text-xs text-base-content/60">
                            {searchQuery.trim()
                              ? `${filteredImages.length} / ${canvasStats.image_count} 张图片`
                              : `${canvasStats.image_count} 张图片`
                            } · {formatFileSize(canvasStats.total_size)}
                          </p>
                        </div>
                      </div>
                      <button
                        className="btn btn-ghost btn-sm text-error"
                        onClick={(e) => {
                          e.stopPropagation();
                          confirmClearCanvasImages(canvasStats.canvas_id, canvasName);
                        }}
                        disabled={isLoading}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    {/* 展开的图片列表 */}
                    {isExpanded && (
                      <div className="p-3 space-y-2 bg-base-100">
                        {allImages.length === 0 ? (
                          <div className="text-center py-4 text-base-content/50 text-sm">
                            <LoadingIndicator size="md" variant="dots" className="text-primary mx-auto mb-2" />
                            加载中...
                          </div>
                        ) : filteredImages.length === 0 ? (
                          <div className="text-center py-4 text-base-content/50 text-sm">
                            <Image className="w-8 h-8 mx-auto mb-2 opacity-30" />
                            <p>没有匹配的图片</p>
                          </div>
                        ) : (
                          filteredImages.map((image) => (
                            <div
                              key={image.id}
                              className="flex items-center gap-3 p-2 bg-base-200 rounded-lg cursor-pointer hover:bg-base-300 transition-colors"
                              onClick={() => setSelectedImage(image)}
                            >
                              {/* 图片预览 */}
                              <div className="w-12 h-12 rounded overflow-hidden flex-shrink-0 bg-base-300 relative">
                                <img
                                  src={getImageUrl(image.path)}
                                  alt={image.filename}
                                  className="w-full h-full object-cover"
                                />
                                {/* 类型标签 */}
                                {image.image_type && (
                                  <div
                                    className={`nc-chip absolute bottom-1 right-1 leading-none ${
                                      image.image_type === "input"
                                        ? "nc-chip-success-solid"
                                        : "nc-chip-solid"
                                    }`}
                                    title={image.image_type === "input" ? "上传的图片" : "生成的图片"}
                                  >
                                    {image.image_type === "input" ? "输入" : "生成"}
                                  </div>
                                )}
                              </div>
                              {/* 图片信息 */}
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">{image.filename}</p>
                                <p className="text-xs text-base-content/60">
                                  {formatFileSize(image.size)} ·{" "}
                                  {new Date(image.created_at * 1000).toLocaleString('zh-CN', {
                                    year: 'numeric',
                                    month: '2-digit',
                                    day: '2-digit',
                                    hour: '2-digit',
                                    minute: '2-digit'
                                  })}
                                </p>
                              </div>
                              {/* 删除按钮 */}
                              <button
                                className="btn btn-ghost btn-xs text-error"
                                onClick={(e) => confirmDeleteImage(e, image.path, image.filename)}
                                disabled={isLoading}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 空状态 */}
        {fileStats.image_count === 0 && fileStats.cache_size === 0 && (
          <div className="nc-empty-state">
            <Image className="w-12 h-12 opacity-30" />
            <p className="nc-empty-state-hint">暂无存储的图片或缓存</p>
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex flex-wrap gap-2 pt-3 border-t border-base-300">
          <button
            className="btn btn-ghost btn-sm flex-1 whitespace-nowrap"
            onClick={refreshStats}
            disabled={isLoading}
          >
            {isLoading ? <LoadingIndicator size="sm" variant="dots" /> : <RefreshCw className="w-4 h-4" />}
            刷新
          </button>
          <button
            className="btn btn-ghost btn-sm flex-1 whitespace-nowrap"
            onClick={handleClearCache}
            disabled={isLoading || fileStats.cache_size === 0}
          >
            <FolderOpen className="w-4 h-4" />
            清理缓存
          </button>
          <button
            className="btn btn-warning btn-sm flex-1 whitespace-nowrap"
            onClick={confirmCleanupUnreferenced}
            disabled={isLoading || fileStats.image_count === 0}
            title="删除存储目录中画布已不再引用的历史副本/未引用图片"
          >
            <Eraser className="w-4 h-4" />
            清理未引用图片
          </button>
          <button
            className="btn btn-error btn-sm flex-1 whitespace-nowrap"
            onClick={confirmClearAllImages}
            disabled={isLoading || fileStats.image_count === 0}
          >
            <Trash2 className="w-4 h-4" />
            清理所有图片
          </button>
        </div>
      </div>
    );
  };

  const modalContent = createPortal(
    <div
      className={`nc-modal-backdrop ${isVisible && !isClosing ? "nc-modal-backdrop-open" : ""}`}
      onClick={handleBackdropClick}
    >
      {/* Modal 内容 */}
      <div
        className={`
          nc-modal nc-modal-lg max-h-[85vh] flex flex-col
          transition-all duration-200 ease-out
          ${contentClasses}
        `}
      >
        {/* 头部 */}
        <div className="nc-modal-header">
          <div>
            <h2 className="nc-modal-title">存储管理</h2>
            <p className="nc-modal-subtitle">
              管理应用的图片存储
            </p>
          </div>
          <button type="button" className="nc-icon-btn" onClick={handleClose} aria-label="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 内容区域 */}
        <div className="nc-modal-body">
          {/* 加载状态 */}
          {isLoading && (
            <div className="flex items-center justify-center py-12">
              <LoadingIndicator size="lg" variant="dots" className="text-primary" />
            </div>
          )}

          {/* 错误状态 */}
          {error && (
            <div className="alert alert-error mb-4">
              <AlertTriangle className="w-5 h-5" />
              <span>{error}</span>
            </div>
          )}

          {/* 根据环境渲染内容 */}
          {!isLoading && renderFileStorage()}
        </div>

        {/* 删除确认对话框 */}
        {deleteConfirm && (
          <ConfirmDialog
            tone={deleteConfirm.type === "unreferenced" ? "warning" : "error"}
            title={deleteConfirm.type === "unreferenced" ? "确认清理未引用图片" : "确认删除"}
            message={getDeleteConfirmMessage()}
            confirmText={deleteConfirm.type === "unreferenced" ? "开始清理" : "确认删除"}
            onConfirm={() => void executeDelete()}
            onClose={() => setDeleteConfirm(null)}
          />
        )}
      </div>
    </div>,
    document.body
  );

  return (
    <>
      {modalContent}
      {/* 图片详情预览 */}
      {selectedImage && (
        <ImageDetailModal
          imageInfo={selectedImage}
          onClose={() => setSelectedImage(null)}
        />
      )}
    </>
  );
}
