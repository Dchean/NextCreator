import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCw,
  Images,
  FolderOpen,
  Maximize2,
  Loader2,
} from "lucide-react";
import { listAllImages, getStorageConfig, getImageUrl, type ImageInfoWithMetadata, type StorageConfigInfo } from "@/services/fileStorageService";
import { useCanvasStore } from "@/stores/canvasStore";
import { Select } from "@/components/ui/Select";
import { ImagePreviewModal } from "@/components/ui/ImagePreviewModal";

// 每页渲染数量（增量渲染，避免一次挂载过多节点）
const PAGE_SIZE = 40;

export function GalleryView() {
  const [images, setImages] = useState<ImageInfoWithMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [storageConfig, setStorageConfig] = useState<StorageConfigInfo | null>(null);
  const [canvasFilter, setCanvasFilter] = useState<string>("all");
  const [modelFilter, setModelFilter] = useState<string>("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [previewImage, setPreviewImage] = useState<ImageInfoWithMetadata | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const canvases = useCanvasStore((s) => s.canvases);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await listAllImages();
      setImages(result);
      setVisibleCount(PAGE_SIZE);
    } catch (e) {
      console.error("[Gallery] 加载图片列表失败:", e);
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 当前生效的存储目录（空状态展示用）
  useEffect(() => {
    getStorageConfig()
      .then(setStorageConfig)
      .catch((e) => console.error("[Gallery] 读取存储配置失败:", e));
  }, []);

  // 可用的模型列表（来自元数据）
  const modelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const img of images) {
      const model = img.metadata?.model;
      if (model) set.add(model);
    }
    return Array.from(set).sort();
  }, [images]);

  const filtered = useMemo(() => {
    return images.filter((img) => {
      if (canvasFilter !== "all" && img.canvas_id !== canvasFilter) return false;
      if (modelFilter !== "all" && img.metadata?.model !== modelFilter) return false;
      return true;
    });
  }, [images, canvasFilter, modelFilter]);

  // 增量渲染：滚动到底部加载更多
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((count) => Math.min(count + PAGE_SIZE, filtered.length));
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [filtered.length]);

  const visibleImages = filtered.slice(0, visibleCount);

  const formatDate = (ts: number) => {
    const d = new Date(ts * 1000);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <>
      {/* 头部 */}
      <div className="p-3 border-b border-base-300 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="nc-section-title">画廊</h3>
          <div className="tooltip tooltip-left" data-tip="刷新">
            <button
              className="btn btn-ghost btn-xs btn-circle"
              onClick={() => void load()}
              disabled={loading}
              aria-label="刷新"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-1.5">
          <Select
            size="xs"
            value={canvasFilter}
            options={[
              { value: "all", label: "全部画布" },
              ...canvases.map((c) => ({ value: c.id, label: c.name })),
            ]}
            onChange={(value) => {
              setCanvasFilter(value);
              setVisibleCount(PAGE_SIZE);
            }}
          />
          <Select
            size="xs"
            value={modelFilter}
            options={[
              { value: "all", label: "全部模型" },
              ...modelOptions.map((m) => ({ value: m, label: m })),
            ]}
            onChange={(value) => {
              setModelFilter(value);
              setVisibleCount(PAGE_SIZE);
            }}
          />
        </div>
        <p className="text-[11px] text-base-content/40">
          {filtered.length} 张图片 · 拖拽到画布可复用
        </p>
      </div>

      {/* 图片网格 */}
      <div className="nc-scrollbar-none flex-1 overflow-y-auto p-2">
        {/* 加载失败提示 */}
        {loadError && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2">
            <span className="min-w-0 break-all text-xs text-warning">{loadError}</span>
            <button
              type="button"
              className="btn btn-warning btn-xs shrink-0"
              onClick={() => void load()}
            >
              <RefreshCw className="h-3 w-3" />
              重试
            </button>
          </div>
        )}
        {loading && images.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-base-content/40">
            <Loader2 className="w-6 h-6 animate-spin mb-2" />
            <p className="text-xs">加载中...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="nc-empty-state">
            <Images className="h-8 w-8 opacity-40" />
            <p className="nc-empty-state-title">还没有图片</p>
            <p className="nc-empty-state-hint">生成的图片会自动出现在这里</p>
            {storageConfig && (
              <p className="mt-2 max-w-full break-all px-2 font-mono text-[11px] text-base-content/40">
                {storageConfig.images_dir}
              </p>
            )}
            {storageConfig?.is_custom && images.length === 0 && (
              <p className="mt-1 text-xs text-warning">
                存储目录已更改且未迁移，旧图片仍在原目录。
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              {visibleImages.map((img) => {
                const thumbSrc = img.thumb_path
                  ? getImageUrl(img.thumb_path)
                  : getImageUrl(img.path);
                const prompt = img.metadata?.prompt;
                return (
                  <div
                    key={img.path}
                    className="group relative overflow-hidden rounded-[var(--nc-radius-md)] border border-base-300 bg-base-200"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(
                        "application/x-nc-image-ref",
                        JSON.stringify({ imagePath: img.path, fileName: img.filename })
                      );
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    title={prompt || img.filename}
                  >
                    <img
                      src={thumbSrc}
                      alt={img.filename}
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                      className="aspect-square w-full cursor-grab object-cover"
                      onDoubleClick={() => setPreviewImage(img)}
                    />
                    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between bg-gradient-to-t from-black/60 via-transparent to-black/30 opacity-0 transition-opacity group-hover:opacity-100">
                      <div className="flex justify-end gap-0.5 p-1">
                        <button
                          type="button"
                          className="nc-icon-btn nc-icon-btn-raised nc-icon-btn-xs pointer-events-auto"
                          title="预览"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreviewImage(img);
                          }}
                        >
                          <Maximize2 className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          className="nc-icon-btn nc-icon-btn-raised nc-icon-btn-xs pointer-events-auto"
                          title="在文件夹中显示"
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
                              await revealItemInDir(img.path);
                            } catch (err) {
                              console.error("[Gallery] 打开文件夹失败:", err);
                            }
                          }}
                        >
                          <FolderOpen className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="p-1.5">
                        {img.metadata?.model && (
                          <div className="truncate text-[11px] text-white/85">{img.metadata.model}</div>
                        )}
                        <div className="truncate text-[11px] text-white/70">{formatDate(img.created_at)}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {visibleCount < filtered.length && (
              <div ref={sentinelRef} className="flex justify-center py-3">
                <Loader2 className="h-4 w-4 animate-spin text-base-content/30" />
              </div>
            )}
          </>
        )}
      </div>

      {/* 底部提示 */}
      <div className="p-3 border-t border-base-300">
        <p className="text-xs text-base-content/40 text-center">拖拽图片到画布中复用</p>
      </div>

      {/* 大图预览 */}
      {previewImage && (
        <ImagePreviewModal
          imagePath={previewImage.path}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </>
  );
}
