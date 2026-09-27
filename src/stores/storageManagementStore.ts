import { create } from "zustand";
import {
  getStorageStats,
  getStoragePath,
  getStorageConfig,
  clearCache,
  clearAllImages,
  deleteCanvasImages,
  listCanvasImages,
  deleteImage,
  cleanupUnreferencedImages,
  formatFileSize,
  type StorageStats,
  type StorageConfigInfo,
  type ImageInfoWithMetadata,
} from "@/services/fileStorageService";
import { collectReferencedImagePaths } from "@/utils/imagePathRewrite";
import { toast } from "@/stores/toastStore";

// 展开的画布 ID 集合
export type ExpandedCanvases = Set<string>;

interface StorageManagementState {
  // UI 状态
  isOpen: boolean;
  isLoading: boolean;

  // 文件存储数据
  fileStats: StorageStats | null;
  storagePath: string | null;
  storageConfig: StorageConfigInfo | null;
  expandedFileCanvases: string[];
  canvasImages: Map<string, ImageInfoWithMetadata[]>;

  // 错误信息
  error: string | null;

  // 操作
  openModal: () => void;
  closeModal: () => void;
  refreshStats: () => Promise<void>;

  // 文件存储操作
  handleClearCache: () => Promise<void>;
  handleClearAllImages: () => Promise<void>;
  handleClearCanvasImages: (canvasId: string) => Promise<void>;
  handleDeleteImage: (path: string) => Promise<void>;
  handleCleanupUnreferenced: () => Promise<void>;
  toggleFileCanvasExpanded: (canvasId: string) => Promise<void>;
  loadCanvasImages: (canvasId: string) => Promise<void>;
}

export const useStorageManagementStore = create<StorageManagementState>(
  (set, get) => ({
    isOpen: false,
    isLoading: false,

    fileStats: null,
    storagePath: null,
    storageConfig: null,
    expandedFileCanvases: [],
    canvasImages: new Map(),

    error: null,

    openModal: async () => {
      set({
        isOpen: true,
        isLoading: true,
        error: null,
      });

      try {
        const [fileStats, storagePath, storageConfig] = await Promise.all([
          getStorageStats(),
          getStoragePath(),
          getStorageConfig(),
        ]);
        set({
          fileStats,
          storagePath,
          storageConfig,
          isLoading: false,
        });
      } catch (err) {
        set({
          error: err instanceof Error ? err.message : "获取存储信息失败",
          isLoading: false,
        });
      }
    },

    closeModal: () => {
      set({
        isOpen: false,
        expandedFileCanvases: [],
        canvasImages: new Map(),
      });
    },

    refreshStats: async () => {
      set({ isLoading: true, error: null });

      try {
        const [fileStats, storageConfig] = await Promise.all([
          getStorageStats(),
          getStorageConfig(),
        ]);
        set({ fileStats, storageConfig, isLoading: false });
      } catch (err) {
        set({
          error: err instanceof Error ? err.message : "刷新失败",
          isLoading: false,
        });
      }
    },

    // === 文件存储操作 ===

    handleClearCache: async () => {
      set({ isLoading: true, error: null });
      try {
        await clearCache();
        await get().refreshStats();
      } catch (err) {
        set({
          error: err instanceof Error ? err.message : "清理缓存失败",
          isLoading: false,
        });
      }
    },

    handleClearAllImages: async () => {
      set({ isLoading: true, error: null });
      try {
        await clearAllImages();
        set({ canvasImages: new Map(), expandedFileCanvases: [] });
        await get().refreshStats();
      } catch (err) {
        set({
          error: err instanceof Error ? err.message : "清理图片失败",
          isLoading: false,
        });
      }
    },

    handleClearCanvasImages: async (canvasId: string) => {
      set({ isLoading: true, error: null });
      try {
        await deleteCanvasImages(canvasId);
        const newCanvasImages = new Map(get().canvasImages);
        newCanvasImages.delete(canvasId);
        set({ canvasImages: newCanvasImages });
        await get().refreshStats();
      } catch (err) {
        set({
          error: err instanceof Error ? err.message : "清理画布图片失败",
          isLoading: false,
        });
      }
    },

    handleDeleteImage: async (path: string) => {
      set({ isLoading: true, error: null });
      try {
        await deleteImage(path);
        const newCanvasImages = new Map(get().canvasImages);
        for (const [canvasId, images] of newCanvasImages) {
          const filtered = images.filter((img) => img.path !== path);
          if (filtered.length !== images.length) {
            newCanvasImages.set(canvasId, filtered);
          }
        }
        set({ canvasImages: newCanvasImages });
        await get().refreshStats();
      } catch (err) {
        set({
          error: err instanceof Error ? err.message : "删除图片失败",
          isLoading: false,
        });
      }
    },

    // 清理未引用图片：保留所有画布仍在引用的路径，删除其余历史副本
    handleCleanupUnreferenced: async () => {
      set({ isLoading: true, error: null });
      try {
        const keepPaths = collectReferencedImagePaths();
        const result = await cleanupUnreferencedImages(keepPaths);
        await get().refreshStats();
        if (result.deleted_count > 0) {
          toast.success(
            `已清理 ${result.deleted_count} 个未引用文件，释放 ${formatFileSize(result.freed_bytes)}`
          );
        } else {
          toast.info("没有可清理的未引用图片");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "清理未引用图片失败";
        set({ error: message, isLoading: false });
        toast.error(message);
      }
    },

    toggleFileCanvasExpanded: async (canvasId: string) => {
      const { expandedFileCanvases, canvasImages } = get();
      const isExpanded = expandedFileCanvases.includes(canvasId);

      if (isExpanded) {
        // 收起
        set({
          expandedFileCanvases: expandedFileCanvases.filter((id) => id !== canvasId),
        });
      } else {
        // 展开并加载图片列表
        set({
          expandedFileCanvases: [...expandedFileCanvases, canvasId],
        });

        // 如果还没加载过，则加载
        if (!canvasImages.has(canvasId)) {
          await get().loadCanvasImages(canvasId);
        }
      }
    },

    loadCanvasImages: async (canvasId: string) => {
      try {
        const images = await listCanvasImages(canvasId);
        const newCanvasImages = new Map(get().canvasImages);
        newCanvasImages.set(canvasId, images);
        set({ canvasImages: newCanvasImages });
      } catch (err) {
        console.error("加载画布图片列表失败:", err);
      }
    },
  })
);
