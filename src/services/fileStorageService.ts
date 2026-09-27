/**
 * 文件存储服务
 * 使用 Tauri 命令将图片存储为独立文件，而不是 base64 存储在 IndexedDB 中
 */

import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as tauriCore from "@tauri-apps/api/core";

// 图片类型枚举
export type ImageType = "input" | "generated";

// 输入图片信息（用于元数据）
export interface InputImageInfo {
  path?: string;
  label: string;
}

// 图片元数据结构
export interface ImageMetadata {
  prompt?: string;
  input_images: InputImageInfo[];
  node_id?: string;
  canvas_id?: string;
  created_at: number;
  model?: string;
}

// 图片信息类型
export interface ImageInfo {
  id: string;
  filename: string;
  path: string;
  size: number;
  created_at: number;
  canvas_id?: string;
  node_id?: string;
  image_type?: ImageType;
  thumb_path?: string;
}

// 带元数据的图片信息
export interface ImageInfoWithMetadata extends ImageInfo {
  metadata?: ImageMetadata;
}

// 存储统计信息类型
export interface StorageStats {
  total_size: number;
  image_count: number;
  cache_size: number;
  images_by_canvas: CanvasImageStats[];
}

export interface CanvasImageStats {
  canvas_id: string;
  image_count: number;
  total_size: number;
}

/**
 * 保存图片到文件系统
 * @param base64Data - 图片的 base64 数据（不含 data:image/xxx;base64, 前缀）
 * @param canvasId - 可选的画布 ID，用于分组存储
 * @param nodeId - 可选的节点 ID
 * @param prompt - 可选的生成提示词
 * @param inputImages - 可选的输入图片信息
 * @param imageType - 可选的图片类型（input/generated）
 * @param model - 可选的生成模型（写入元数据，画廊用）
 * @returns 图片信息
 */
export async function saveImage(
  base64Data: string,
  canvasId?: string,
  nodeId?: string,
  prompt?: string,
  inputImages?: InputImageInfo[],
  imageType?: ImageType,
  model?: string
): Promise<ImageInfo> {
  return await invoke<ImageInfo>("save_image", {
    base64Data,
    canvasId,
    nodeId,
    prompt,
    inputImages,
    imageType,
    model,
  });
}

/**
 * 确保图片有缩略图（无则生成），返回缩略图路径；图片不存在或解析失败返回 null
 */
export async function ensureThumbnail(imagePath: string): Promise<string | null> {
  return await invoke<string | null>("ensure_thumbnail", { imagePath });
}

/**
 * 读取图片文件（返回 base64）
 * @param path - 图片文件路径
 * @returns base64 编码的图片数据
 */
export async function readImage(path: string): Promise<string> {
  return await invoke<string>("read_image", { path });
}

/**
 * 扩展 asset protocol 授权，允许 webview 通过 convertFileSrc 访问指定的本地原文件。
 * 用于"本地图片零拷贝引用"：导入本地图片时按原始绝对路径引用，不复制进应用存储目录。
 * @param paths - 本地文件的绝对路径列表
 */
export async function ensureAssetPathsAllowed(paths: string[]): Promise<void> {
  await invoke("ensure_asset_paths_allowed", { paths });
}

/**
 * 从拖放的 File 对象解析真实的本地文件系统路径（尽力而为）。
 * 说明：当前 @tauri-apps/api（2.9.x，已核对至最新 2.12.0）尚未导出
 * `webUtils.getPathForFile`（那是 Electron 的 API）。此函数做运行时特性检测：
 * - 若未来版本的 @tauri-apps/api/core 提供 `webUtils.getPathForFile` 则直接使用；
 * - 否则回退到 File 对象上的 `path` 属性（部分 WebView 会注入）；
 * - 均不可用时返回空字符串，调用方应回退到 FileReader base64 流程。
 */
export function getFilePathForDroppedFile(file: File): string {
  try {
    const webUtils = (tauriCore as unknown as {
      webUtils?: { getPathForFile?: (f: File) => string };
    }).webUtils;
    if (typeof webUtils?.getPathForFile === "function") {
      const path = webUtils.getPathForFile(file);
      if (path) return path;
    }
  } catch {
    // 忽略并尝试下一个途径
  }
  try {
    const legacy = (file as File & { path?: unknown }).path;
    if (typeof legacy === "string" && legacy) return legacy;
  } catch {
    // 忽略
  }
  return "";
}

// 清理未引用图片结果
export interface CleanupResult {
  deleted_count: number;
  freed_bytes: number;
}

/**
 * 清理存储目录中未被画布引用的历史图片/元数据副本。
 * 后端仅会删除 images_dir 内不在保留集合中的图片与 .meta.json 文件。
 * @param keepPaths - 所有画布仍在引用的图片绝对路径
 */
export async function cleanupUnreferencedImages(keepPaths: string[]): Promise<CleanupResult> {
  return await invoke<CleanupResult>("cleanup_unreferenced_images", { keepPaths });
}

/**
 * 获取图片的可访问 URL
 * 使用 Tauri 的 convertFileSrc 将本地路径转换为 webview 可访问的 URL
 * @param path - 图片文件路径
 * @returns 可在 webview 中使用的 URL
 */
export function getImageUrl(path: string): string {
  return convertFileSrc(path);
}

/**
 * 删除图片文件
 * @param path - 图片文件路径
 */
export async function deleteImage(path: string): Promise<void> {
  await invoke("delete_image", { path });
}

/**
 * 删除画布的所有图片
 * @param canvasId - 画布 ID
 * @returns 删除的总大小（字节）
 */
export async function deleteCanvasImages(canvasId: string): Promise<number> {
  return await invoke<number>("delete_canvas_images", { canvasId });
}

/**
 * 获取存储统计信息
 * @returns 存储统计数据
 */
export async function getStorageStats(): Promise<StorageStats> {
  return await invoke<StorageStats>("get_storage_stats");
}

/**
 * 清理缓存
 * @returns 清理的大小（字节）
 */
export async function clearCache(): Promise<number> {
  return await invoke<number>("clear_cache");
}

/**
 * 清理所有图片
 * @returns 清理的大小（字节）
 */
export async function clearAllImages(): Promise<number> {
  return await invoke<number>("clear_all_images");
}

/**
 * 获取应用存储路径
 * @returns 存储目录路径
 */
export async function getStoragePath(): Promise<string> {
  return await invoke<string>("get_storage_path");
}

// 存储配置信息
export interface StorageConfigInfo {
  images_dir: string;   // 当前生效的图片根目录（绝对路径）
  default_dir: string;  // 默认目录（app-data/images）
  is_custom: boolean;   // 是否使用自定义目录
}

// 迁移结果
export interface MigrationResult {
  moved_files: number;
  moved_bytes: number;
  failed_files: number;
}

/**
 * 获取存储配置（当前生效目录 / 默认目录 / 是否自定义）
 */
export async function getStorageConfig(): Promise<StorageConfigInfo> {
  return await invoke<StorageConfigInfo>("get_storage_config");
}

/**
 * 设置图片存储目录（传 null / 空字符串恢复默认）
 * @returns 当前生效目录
 */
export async function setStorageConfig(imagesDir?: string | null): Promise<string> {
  return await invoke<string>("set_storage_config", { imagesDir: imagesDir ?? null });
}

/**
 * 将现有图片迁移到新的存储目录（内部会写入新配置）
 */
export async function migrateImagesStorage(newDir: string): Promise<MigrationResult> {
  return await invoke<MigrationResult>("migrate_images_storage", { newDir });
}

/**
 * 列出画布的所有图片（包含元数据）
 * @param canvasId - 画布 ID
 * @returns 图片信息列表（包含元数据）
 */
export async function listCanvasImages(canvasId: string): Promise<ImageInfoWithMetadata[]> {
  return await invoke<ImageInfoWithMetadata[]>("list_canvas_images", { canvasId });
}

/**
 * 列出所有画布的图片（全局画廊用，按时间倒序）
 */
export async function listAllImages(): Promise<ImageInfoWithMetadata[]> {
  return await invoke<ImageInfoWithMetadata[]>("list_all_images");
}

/**
 * 读取单个图片的元数据
 * @param imagePath - 图片文件路径
 * @returns 图片元数据（如果存在）
 */
export async function readImageMetadata(imagePath: string): Promise<ImageMetadata | null> {
  return await invoke<ImageMetadata | null>("read_image_metadata", { imagePath });
}

/**
 * 格式化文件大小
 * @param bytes - 字节数
 * @returns 格式化后的字符串（如 "1.5 MB"）
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${units[i]}`;
}

export function isTauriEnvironment(): boolean {
  return true;
}
