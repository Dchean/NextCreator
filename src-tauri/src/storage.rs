use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use tauri::Manager;
use uuid::Uuid;

// 缩略图最长边（像素）
const THUMBNAIL_MAX_SIDE: u32 = 512;

// 图片类型枚举
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum ImageType {
    Input,     // 用户上传的输入图片
    Generated, // AI 生成的图片
}

// 图片信息结构
#[derive(Debug, Serialize, Deserialize)]
pub struct ImageInfo {
    pub id: String,
    pub filename: String,
    pub path: String,
    pub size: u64,
    pub created_at: i64,
    pub canvas_id: Option<String>,
    pub node_id: Option<String>,
    pub image_type: Option<ImageType>, // 新增：图片类型
    pub thumb_path: Option<String>,    // 缩略图路径（预览优化）
}

// 图片元数据结构（持久化存储）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageMetadata {
    pub prompt: Option<String>,
    pub input_images: Vec<InputImageInfo>,
    pub node_id: Option<String>,
    pub canvas_id: Option<String>,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>, // 生成模型（画廊筛选用，旧文件无此字段）
}

// 输入图片信息
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InputImageInfo {
    pub path: Option<String>,
    pub label: String,
}

// 带元数据的图片信息（用于前端）
#[derive(Debug, Serialize, Deserialize)]
pub struct ImageInfoWithMetadata {
    pub id: String,
    pub filename: String,
    pub path: String,
    pub size: u64,
    pub created_at: i64,
    pub canvas_id: Option<String>,
    pub node_id: Option<String>,
    pub image_type: Option<ImageType>, // 新增：图片类型
    pub metadata: Option<ImageMetadata>,
    pub thumb_path: Option<String>, // 缩略图路径
}

// 存储统计信息
#[derive(Debug, Serialize, Deserialize)]
pub struct StorageStats {
    pub total_size: u64,
    pub image_count: usize,
    pub cache_size: u64,
    pub images_by_canvas: Vec<CanvasImageStats>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CanvasImageStats {
    pub canvas_id: String,
    pub image_count: usize,
    pub total_size: u64,
}

// 获取应用数据目录
fn get_app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))
}

// ==================== 存储位置配置 ====================

// 存储配置（持久化在 app-data/storage-config.json）
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct StorageConfig {
    // 自定义图片根目录；None 或空字符串表示使用默认目录
    pub images_dir: Option<String>,
}

// 返回给前端的存储配置信息
#[derive(Debug, Serialize, Deserialize)]
pub struct StorageConfigInfo {
    pub images_dir: String,        // 当前生效的图片根目录（绝对路径）
    pub default_dir: String,       // 默认目录（app-data/images）
    pub is_custom: bool,           // 是否使用自定义目录
}

// 迁移结果
#[derive(Debug, Serialize, Deserialize)]
pub struct MigrationResult {
    pub moved_files: u64,
    pub moved_bytes: u64,
    pub failed_files: u64,
}

// 规范化用户输入的目录：去首尾空白与末尾斜杠。
// 例外：裁剪后若只剩盘符（如 "D:"，来自 "D:\" 或 "D:/"），补回反斜杠，
// 避免把盘符根目录裁成 "D:" 这种盘符相对路径导致写入到进程当前目录。
fn normalize_dir_input(dir: &str) -> String {
    let trimmed = dir.trim().trim_end_matches(['\\', '/']);
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() == 2 && chars[0].is_ascii_alphabetic() && chars[1] == ':' {
        return format!("{}\\", trimmed);
    }
    trimmed.to_string()
}

fn get_storage_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(get_app_data_dir(app)?.join("storage-config.json"))
}

fn read_storage_config(app: &tauri::AppHandle) -> StorageConfig {
    let Ok(path) = get_storage_config_path(app) else {
        return StorageConfig::default();
    };
    if !path.exists() {
        return StorageConfig::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn write_storage_config(app: &tauri::AppHandle, config: &StorageConfig) -> Result<(), String> {
    let path = get_storage_config_path(app)?;
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("序列化存储配置失败: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("写入存储配置失败: {}", e))
}

fn get_default_images_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = get_app_data_dir(app)?;
    let images_dir = app_data.join("images");
    if !images_dir.exists() {
        fs::create_dir_all(&images_dir).map_err(|e| format!("创建图片目录失败: {}", e))?;
    }
    Ok(images_dir)
}

fn ensure_asset_scope(app: &tauri::AppHandle, dir: &Path) {
    // 自定义目录可能位于 app-data 之外，需要扩展 asset protocol 授权，
    // 否则前端 convertFileSrc 生成的 URL 会被拒绝
    let scope = app.asset_protocol_scope();
    let _ = scope.allow_directory(dir, true);
}

// 启动时调用：为配置中的自定义目录（若存在）扩展 asset 授权
pub fn ensure_custom_dir_asset_scope(app: &tauri::AppHandle) {
    let config = read_storage_config(app);
    if let Some(dir) = config.images_dir {
        let trimmed = dir.trim().to_string();
        if !trimmed.is_empty() {
            ensure_asset_scope(app, Path::new(&trimmed));
        }
    }
}

// 获取图片存储目录（优先使用用户配置的自定义目录）
fn get_images_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config = read_storage_config(app);
    if let Some(dir) = config.images_dir {
        let trimmed = dir.trim().to_string();
        if !trimmed.is_empty() {
            let images_dir = PathBuf::from(&trimmed);
            if !images_dir.exists() {
                fs::create_dir_all(&images_dir).map_err(|e| format!("创建图片目录失败: {}", e))?;
            }
            return Ok(images_dir);
        }
    }
    get_default_images_dir(app)
}

// 获取存储配置（供前端显示）
#[tauri::command]
pub fn get_storage_config(app: tauri::AppHandle) -> Result<StorageConfigInfo, String> {
    let default_dir = get_default_images_dir(&app)?;
    let effective_dir = get_images_dir(&app)?;
    let config = read_storage_config(&app);
    let is_custom = config
        .images_dir
        .map(|d| !d.trim().is_empty())
        .unwrap_or(false);

    Ok(StorageConfigInfo {
        images_dir: effective_dir.to_string_lossy().to_string(),
        default_dir: default_dir.to_string_lossy().to_string(),
        is_custom,
    })
}

// 设置存储目录（None / 空字符串 = 恢复默认）。返回当前生效目录。
#[tauri::command]
pub fn set_storage_config(
    app: tauri::AppHandle,
    images_dir: Option<String>,
) -> Result<String, String> {
    let trimmed = images_dir.map(|d| normalize_dir_input(&d)).filter(|d| !d.is_empty());

    let effective_dir = match &trimmed {
        Some(dir) => {
            let path = PathBuf::from(dir);
            if !path.exists() {
                fs::create_dir_all(&path).map_err(|e| format!("创建目录失败: {}", e))?;
            }
            path
        }
        None => get_default_images_dir(&app)?,
    };

    ensure_asset_scope(&app, &effective_dir);
    write_storage_config(
        &app,
        &StorageConfig {
            images_dir: trimmed,
        },
    )?;

    Ok(effective_dir.to_string_lossy().to_string())
}

// 将现有图片（含元数据）迁移到新的存储目录
#[tauri::command]
pub fn migrate_images_storage(
    app: tauri::AppHandle,
    new_dir: String,
) -> Result<MigrationResult, String> {
    let new_dir = normalize_dir_input(&new_dir);
    if new_dir.is_empty() {
        return Err("目标目录不能为空".to_string());
    }

    let old_dir = get_images_dir(&app)?;
    let new_root = PathBuf::from(&new_dir);
    if !new_root.exists() {
        fs::create_dir_all(&new_root).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }

    // 目录相同则无需迁移
    if old_dir == new_root {
        return Ok(MigrationResult {
            moved_files: 0,
            moved_bytes: 0,
            failed_files: 0,
        });
    }

    // 目标目录不能位于当前图片目录内部，否则会造成递归自移动导致数据丢失
    let old_canon = old_dir.canonicalize().unwrap_or(old_dir.clone());
    let new_canon = new_root.canonicalize().unwrap_or(new_root.clone());
    if new_canon == old_canon {
        // 规范化后是同一目录（大小写/分隔符差异），无需迁移
        return Ok(MigrationResult {
            moved_files: 0,
            moved_bytes: 0,
            failed_files: 0,
        });
    }
    if new_canon.starts_with(&old_canon) {
        return Err("目标目录不能位于当前图片目录内部".to_string());
    }

    let mut result = MigrationResult {
        moved_files: 0,
        moved_bytes: 0,
        failed_files: 0,
    };

    // 递归迁移：根目录文件 + 画布子目录
    fn move_dir_contents(src: &Path, dst: &Path, result: &mut MigrationResult) {
        let Ok(entries) = fs::read_dir(src) else {
            return;
        };
        for entry in entries.flatten() {
            let from = entry.path();
            let to = dst.join(entry.file_name());
            if from.is_dir() {
                if fs::create_dir_all(&to).is_ok() {
                    move_dir_contents(&from, &to, result);
                }
                let _ = fs::remove_dir(&from);
            } else if from.is_file() {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                // 同盘 rename，跨盘 copy + delete
                let moved = fs::rename(&from, &to).or_else(|_| {
                    fs::copy(&from, &to).and_then(|_| fs::remove_file(&from))
                });
                if moved.is_ok() {
                    result.moved_files += 1;
                    result.moved_bytes += size;
                } else {
                    result.failed_files += 1;
                }
            }
        }
    }

    move_dir_contents(&old_dir, &new_root, &mut result);

    // 仅在全部文件迁移成功时清理旧目录；有失败文件时保留旧目录，避免误删未迁移的数据
    if result.failed_files == 0 {
        let _ = fs::remove_dir_all(&old_dir);
    }

    ensure_asset_scope(&app, &new_root);
    write_storage_config(
        &app,
        &StorageConfig {
            images_dir: Some(new_dir),
        },
    )?;

    // 迁移后原图绝对路径变化，缩略图文件名按原路径哈希，全部失效，清空缩略图缓存
    if result.moved_files > 0 {
        if let Ok(thumbs_dir) = get_thumbs_dir(&app) {
            let _ = fs::remove_dir_all(&thumbs_dir);
            let _ = fs::create_dir_all(&thumbs_dir);
        }
    }

    Ok(result)
}

// 获取缓存目录
fn get_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = get_app_data_dir(app)?;
    let cache_dir = app_data.join("cache");
    if !cache_dir.exists() {
        fs::create_dir_all(&cache_dir).map_err(|e| format!("创建缓存目录失败: {}", e))?;
    }
    Ok(cache_dir)
}

// ==================== 缩略图 ====================

fn get_thumbs_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let cache_dir = get_cache_dir(app)?;
    let thumbs_dir = cache_dir.join("thumbs");
    if !thumbs_dir.exists() {
        fs::create_dir_all(&thumbs_dir).map_err(|e| format!("创建缩略图目录失败: {}", e))?;
    }
    Ok(thumbs_dir)
}

// 根据原图路径生成唯一的缩略图文件名
fn thumbnail_name_for(image_path: &str) -> String {
    let mut hasher = DefaultHasher::new();
    image_path.hash(&mut hasher);
    format!("{:016x}.jpg", hasher.finish())
}

// 已有缩略图路径（仅查找，不生成）
fn find_thumbnail(app: &tauri::AppHandle, image_path: &str) -> Option<String> {
    let thumbs_dir = get_thumbs_dir(app).ok()?;
    let thumb_path = thumbs_dir.join(thumbnail_name_for(image_path));
    thumb_path
        .exists()
        .then(|| thumb_path.to_string_lossy().to_string())
}

// 生成缩略图并返回其路径（失败返回 None，不影响主流程）
fn generate_thumbnail_file(app: &tauri::AppHandle, image_path: &str) -> Option<String> {
    let thumbs_dir = get_thumbs_dir(app).ok()?;
    let thumb_path = thumbs_dir.join(thumbnail_name_for(image_path));

    if thumb_path.exists() {
        return Some(thumb_path.to_string_lossy().to_string());
    }

    let img = image::open(image_path).ok()?;
    let thumb = img.resize(THUMBNAIL_MAX_SIDE, THUMBNAIL_MAX_SIDE, image::imageops::FilterType::Triangle);
    let rgb = thumb.to_rgb8();

    let mut buf = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(rgb)
        .write_to(&mut buf, image::ImageFormat::Jpeg)
        .ok()?;

    fs::write(&thumb_path, buf.into_inner()).ok()?;
    Some(thumb_path.to_string_lossy().to_string())
}

// 确保指定图片有缩略图（无则生成），返回缩略图路径
#[tauri::command]
pub fn ensure_thumbnail(app: tauri::AppHandle, image_path: String) -> Result<Option<String>, String> {
    if !Path::new(&image_path).exists() {
        return Ok(None);
    }
    Ok(generate_thumbnail_file(&app, &image_path))
}

fn guess_image_extension(image_data: &[u8]) -> &'static str {
    if image_data.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if image_data.starts_with(b"\xff\xd8\xff") {
        "jpg"
    } else if image_data.len() >= 12
        && &image_data[0..4] == b"RIFF"
        && &image_data[8..12] == b"WEBP"
    {
        "webp"
    } else if image_data.starts_with(b"GIF87a") || image_data.starts_with(b"GIF89a") {
        "gif"
    } else {
        "png"
    }
}

// 保存图片（从 base64）- 同时保存元数据
#[tauri::command]
pub fn save_image(
    app: tauri::AppHandle,
    base64_data: String,
    canvas_id: Option<String>,
    node_id: Option<String>,
    prompt: Option<String>,
    input_images: Option<Vec<InputImageInfo>>,
    image_type: Option<ImageType>, // 新增：图片类型
    model: Option<String>,         // 生成模型（写入元数据，画廊用）
) -> Result<ImageInfo, String> {
    let images_dir = get_images_dir(&app)?;

    // 根据 canvas_id 创建子目录
    let target_dir = if let Some(ref cid) = canvas_id {
        let canvas_dir = images_dir.join(cid);
        if !canvas_dir.exists() {
            fs::create_dir_all(&canvas_dir).map_err(|e| format!("创建画布目录失败: {}", e))?;
        }
        canvas_dir
    } else {
        images_dir
    };

    // 解码 base64
    let image_data = general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Base64 解码失败: {}", e))?;

    // 生成唯一文件名
    let id = Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp();
    let ext = guess_image_extension(&image_data);
    let filename = format!("{}_{}.{}", id, timestamp, ext);
    let file_path = target_dir.join(&filename);

    // 写入图片文件
    fs::write(&file_path, &image_data).map_err(|e| format!("写入文件失败: {}", e))?;

    // 保存元数据文件（如果有提示词或输入图片）
    if prompt.is_some() || input_images.is_some() || model.is_some() {
        let metadata = ImageMetadata {
            prompt: prompt.clone(),
            input_images: input_images.unwrap_or_default(),
            node_id: node_id.clone(),
            canvas_id: canvas_id.clone(),
            created_at: timestamp,
            model: model.clone(),
        };

        let meta_filename = format!("{}_{}.meta.json", id, timestamp);
        let meta_path = target_dir.join(&meta_filename);

        let meta_json = serde_json::to_string_pretty(&metadata)
            .map_err(|e| format!("序列化元数据失败: {}", e))?;

        fs::write(&meta_path, meta_json).map_err(|e| format!("写入元数据失败: {}", e))?;
    }

    let path_str = file_path.to_str().ok_or("路径转换失败")?.to_string();

    // 生成缩略图（失败不影响保存）
    let thumb_path = generate_thumbnail_file(&app, &path_str);

    Ok(ImageInfo {
        id,
        filename,
        path: path_str,
        size: image_data.len() as u64,
        created_at: timestamp,
        canvas_id,
        node_id,
        image_type, // 返回图片类型
        thumb_path,
    })
}

// 读取图片（返回 base64）
#[tauri::command]
pub fn read_image(path: String) -> Result<String, String> {
    let data = fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(general_purpose::STANDARD.encode(&data))
}

// 删除图片
#[tauri::command]
pub fn delete_image(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // 同步删除派生的缩略图
    if let Ok(thumbs_dir) = get_thumbs_dir(&app) {
        let thumb_path = thumbs_dir.join(thumbnail_name_for(&path));
        if thumb_path.exists() {
            let _ = fs::remove_file(&thumb_path);
        }
    }
    fs::remove_file(&path).map_err(|e| format!("删除文件失败: {}", e))
}

// 删除画布的所有图片
#[tauri::command]
pub fn delete_canvas_images(app: tauri::AppHandle, canvas_id: String) -> Result<u64, String> {
    let images_dir = get_images_dir(&app)?;
    let canvas_dir = images_dir.join(&canvas_id);

    if !canvas_dir.exists() {
        return Ok(0);
    }

    let mut deleted_size: u64 = 0;

    // 遍历并删除目录中的所有文件
    if let Ok(entries) = fs::read_dir(&canvas_dir) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if metadata.is_file() {
                    deleted_size += metadata.len();
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }

    // 删除空目录
    let _ = fs::remove_dir(&canvas_dir);

    Ok(deleted_size)
}

// 获取存储统计信息
#[tauri::command]
pub fn get_storage_stats(app: tauri::AppHandle) -> Result<StorageStats, String> {
    let images_dir = get_images_dir(&app)?;
    let cache_dir = get_cache_dir(&app)?;

    let mut total_size: u64 = 0;
    let mut image_count: usize = 0;
    let mut images_by_canvas: Vec<CanvasImageStats> = Vec::new();

    // 统计图片目录
    if images_dir.exists() {
        if let Ok(entries) = fs::read_dir(&images_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    // 这是一个画布目录
                    let canvas_id = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("unknown")
                        .to_string();

                    let mut canvas_size: u64 = 0;
                    let mut canvas_count: usize = 0;

                    if let Ok(files) = fs::read_dir(&path) {
                        for file in files.flatten() {
                            if let Ok(metadata) = file.metadata() {
                                if metadata.is_file() {
                                    // 只统计图片文件，排除元数据文件
                                    let filename =
                                        file.file_name().to_str().unwrap_or("").to_string();
                                    if !filename.ends_with(".meta.json") {
                                        canvas_size += metadata.len();
                                        canvas_count += 1;
                                    }
                                }
                            }
                        }
                    }

                    total_size += canvas_size;
                    image_count += canvas_count;

                    images_by_canvas.push(CanvasImageStats {
                        canvas_id,
                        image_count: canvas_count,
                        total_size: canvas_size,
                    });
                } else if path.is_file() {
                    // 根目录的图片
                    if let Ok(metadata) = entry.metadata() {
                        total_size += metadata.len();
                        image_count += 1;
                    }
                }
            }
        }
    }

    // 统计缓存目录
    let mut cache_size: u64 = 0;
    if cache_dir.exists() {
        cache_size = calculate_dir_size(&cache_dir);
    }

    Ok(StorageStats {
        total_size,
        image_count,
        cache_size,
        images_by_canvas,
    })
}

// 清理缓存
#[tauri::command]
pub fn clear_cache(app: tauri::AppHandle) -> Result<u64, String> {
    let cache_dir = get_cache_dir(&app)?;
    let cleared_size = calculate_dir_size(&cache_dir);

    if cache_dir.exists() {
        fs::remove_dir_all(&cache_dir).map_err(|e| format!("清理缓存失败: {}", e))?;
        fs::create_dir_all(&cache_dir).map_err(|e| format!("重建缓存目录失败: {}", e))?;
    }

    Ok(cleared_size)
}

// 清理所有图片
#[tauri::command]
pub fn clear_all_images(app: tauri::AppHandle) -> Result<u64, String> {
    let images_dir = get_images_dir(&app)?;
    let cleared_size = calculate_dir_size(&images_dir);

    if images_dir.exists() {
        fs::remove_dir_all(&images_dir).map_err(|e| format!("清理图片失败: {}", e))?;
        fs::create_dir_all(&images_dir).map_err(|e| format!("重建图片目录失败: {}", e))?;
    }

    Ok(cleared_size)
}

// 获取应用数据目录路径（供前端显示）
#[tauri::command]
pub fn get_storage_path(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = get_app_data_dir(&app)?;
    app_data
        .to_str()
        .map(|s| s.to_string())
        .ok_or("路径转换失败".to_string())
}

// 从目录收集图片信息（含元数据）
fn collect_images_from_dir(app: &tauri::AppHandle, dir: &Path, canvas_id: Option<String>) -> Vec<ImageInfoWithMetadata> {
    let mut images: Vec<ImageInfoWithMetadata> = Vec::new();

    let Ok(entries) = fs::read_dir(dir) else {
        return images;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let filename = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();

            // 跳过元数据文件，只处理图片文件
            if filename.ends_with(".meta.json") {
                continue;
            }

            if let Ok(file_metadata) = entry.metadata() {
                // 从文件名解析 ID 和时间戳（格式: {id}_{timestamp}.png）
                let parts: Vec<&str> = filename.split('_').collect();
                let id = parts.first().unwrap_or(&"unknown").to_string();

                // 尝试从文件名获取时间戳，否则使用文件创建时间
                let created_at = if parts.len() >= 2 {
                    parts[1]
                        .split('.')
                        .next()
                        .and_then(|s| s.parse::<i64>().ok())
                        .unwrap_or_else(|| file_created_at(&file_metadata))
                } else {
                    file_created_at(&file_metadata)
                };

                // 尝试读取对应的元数据文件（{stem}.meta.json）
                let meta_filename = match path.extension().and_then(|e| e.to_str()) {
                    Some(ext) => filename.replace(&format!(".{}", ext), ".meta.json"),
                    None => continue,
                };
                let meta_path = dir.join(&meta_filename);
                let metadata = if meta_path.exists() {
                    fs::read_to_string(&meta_path).ok().and_then(|content| {
                        serde_json::from_str::<ImageMetadata>(&content).ok()
                    })
                } else {
                    None
                };

                // 从元数据中获取 node_id
                let node_id = metadata.as_ref().and_then(|m| m.node_id.clone());

                // 推断图片类型：有 prompt 说明是生成的，否则可能是输入的
                let image_type = if metadata.as_ref().and_then(|m| m.prompt.as_ref()).is_some()
                {
                    Some(ImageType::Generated)
                } else if metadata.is_none() {
                    // 旧数据没有元数据，可能是输入图片
                    Some(ImageType::Input)
                } else {
                    None
                };

                images.push(ImageInfoWithMetadata {
                    id,
                    filename,
                    path: path.to_str().unwrap_or("").to_string(),
                    size: file_metadata.len(),
                    created_at,
                    canvas_id: canvas_id.clone(),
                    node_id,
                    image_type,
                    metadata,
                    thumb_path: find_thumbnail(app, &path.to_string_lossy()),
                });
            }
        }
    }

    images
}

fn file_created_at(metadata: &fs::Metadata) -> i64 {
    metadata
        .created()
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
        })
        .unwrap_or(0)
}

// 列出画布的所有图片（带元数据）
#[tauri::command]
pub fn list_canvas_images(
    app: tauri::AppHandle,
    canvas_id: String,
) -> Result<Vec<ImageInfoWithMetadata>, String> {
    let images_dir = get_images_dir(&app)?;
    let canvas_dir = images_dir.join(&canvas_id);

    let mut images = collect_images_from_dir(&app, &canvas_dir, Some(canvas_id));

    // 按创建时间排序（最新的在前）
    images.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    Ok(images)
}

// 列出所有画布的图片（全局画廊用）
#[tauri::command]
pub fn list_all_images(app: tauri::AppHandle) -> Result<Vec<ImageInfoWithMetadata>, String> {
    let images_dir = get_images_dir(&app)?;
    let mut images: Vec<ImageInfoWithMetadata> = Vec::new();

    if !images_dir.exists() {
        return Ok(images);
    }

    // 根目录下的散图（无画布归属，canvas_id 为 None）
    images.extend(collect_images_from_dir(&app, &images_dir, None));

    if let Ok(entries) = fs::read_dir(&images_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // 画布子目录
                let canvas_id = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                images.extend(collect_images_from_dir(&app, &path, Some(canvas_id)));
            }
        }
    }

    // 按创建时间排序（最新的在前）
    images.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    Ok(images)
}

// 读取单个图片的元数据
#[tauri::command]
pub fn read_image_metadata(image_path: String) -> Result<Option<ImageMetadata>, String> {
    // 从图片路径构造元数据文件路径（替换扩展名，兼容 png/jpg/webp 等）
    let path = std::path::Path::new(&image_path);
    let meta_path = match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let meta_filename = filename.replace(&format!(".{}", ext), ".meta.json");
            path.with_file_name(meta_filename)
        }
        None => return Ok(None),
    };

    if !meta_path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&meta_path).map_err(|e| format!("读取元数据失败: {}", e))?;

    let metadata: ImageMetadata =
        serde_json::from_str(&content).map_err(|e| format!("解析元数据失败: {}", e))?;

    Ok(Some(metadata))
}

// 辅助函数：计算目录大小
fn calculate_dir_size(path: &PathBuf) -> u64 {
    let mut size: u64 = 0;

    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                size += calculate_dir_size(&entry_path);
            } else if let Ok(metadata) = entry.metadata() {
                size += metadata.len();
            }
        }
    }

    size
}

// ==================== 本地原图零拷贝引用 ====================

// 为任意本地原图扩展 asset protocol 授权，使前端 convertFileSrc 的 URL 可访问。
// 对每个存在的路径：允许该文件本身，同时允许其所在目录（非递归，便于预览变体）。
// 单项失败仅记录日志；只有当全部路径都授权失败时才返回 Err 提示。
#[tauri::command]
pub fn ensure_asset_paths_allowed(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    let scope = app.asset_protocol_scope();
    let mut attempted = 0usize;
    let mut failed: Vec<String> = Vec::new();

    for raw in &paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = Path::new(trimmed);
        if !path.exists() {
            // 路径不存在（可能已被移动/删除）时无需授权
            continue;
        }
        attempted += 1;

        let mut granted = false;
        if let Err(err) = scope.allow_file(path) {
            eprintln!("[asset-scope] 允许文件失败: {} - {}", trimmed, err);
        } else {
            granted = true;
        }

        if let Some(parent) = path.parent() {
            if let Err(err) = scope.allow_directory(parent, false) {
                eprintln!("[asset-scope] 允许目录失败: {:?} - {}", parent, err);
            } else {
                granted = true;
            }
        }

        if !granted {
            failed.push(trimmed.to_string());
        }
    }

    if attempted > 0 && failed.len() == attempted {
        return Err(format!(
            "asset 授权全部失败（共 {} 项）：图片可能无法预览",
            failed.len()
        ));
    }

    Ok(())
}

// ==================== 未引用图片清理 ====================

// 清理结果
#[derive(Debug, Serialize, Deserialize)]
pub struct CleanupResult {
    pub deleted_count: u64,
    pub freed_bytes: u64,
}

// 归一化用于比较的路径：Windows 下统一分隔符并转小写，其余平台仅修剪空白
fn normalize_path_for_compare(path: &str) -> String {
    let trimmed = path.trim();
    if cfg!(windows) {
        trimmed.replace('/', "\\").to_lowercase()
    } else {
        trimmed.to_string()
    }
}

// 递归收集目录下的文件与子目录
fn collect_files_recursively(dir: &Path, files: &mut Vec<PathBuf>, dirs: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            dirs.push(path.clone());
            collect_files_recursively(&path, files, dirs);
        } else if path.is_file() {
            files.push(path);
        }
    }
}

// 清理存储目录中未被画布引用的历史图片/元数据。
// 安全性：仅删除 get_images_dir() 内、扩展名为图片或 .meta.json 的文件；
// 保留集合之外的文件一律视为孤儿删除，空目录一并移除。
#[tauri::command]
pub fn cleanup_unreferenced_images(
    app: tauri::AppHandle,
    keep_paths: Vec<String>,
) -> Result<CleanupResult, String> {
    let images_dir = get_images_dir(&app)?;
    if !images_dir.exists() {
        return Ok(CleanupResult {
            deleted_count: 0,
            freed_bytes: 0,
        });
    }

    // 归一化保留集合：完整路径 + 文件名主干（用于保留对应 .meta.json）
    let mut keep_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut keep_stems: std::collections::HashSet<String> = std::collections::HashSet::new();
    for raw in &keep_paths {
        let normalized = normalize_path_for_compare(raw);
        if normalized.is_empty() {
            continue;
        }
        keep_set.insert(normalized);
        if let Some(stem) = Path::new(raw.trim())
            .file_stem()
            .and_then(|s| s.to_str())
        {
            keep_stems.insert(stem.to_lowercase());
        }
    }

    let mut files: Vec<PathBuf> = Vec::new();
    let mut dirs: Vec<PathBuf> = Vec::new();
    collect_files_recursively(&images_dir, &mut files, &mut dirs);

    let mut result = CleanupResult {
        deleted_count: 0,
        freed_bytes: 0,
    };

    for file in files {
        let Some(filename) = file.file_name().and_then(|n| n.to_str()) else {
            continue;
        };

        let is_meta = filename.ends_with(".meta.json");
        let is_image = matches!(
            file.extension().and_then(|e| e.to_str()),
            Some("png" | "jpg" | "jpeg" | "webp" | "gif")
        );
        // 只处理图片/元数据文件，其他文件一律不动
        if !is_meta && !is_image {
            continue;
        }

        let referenced = if is_meta {
            // 元数据文件跟随同名图片：uuid_ts.meta.json ↔ uuid_ts.{ext}
            let stem = filename
                .strip_suffix(".meta.json")
                .unwrap_or(filename)
                .to_lowercase();
            keep_stems.contains(&stem)
        } else {
            keep_set.contains(&normalize_path_for_compare(&file.to_string_lossy()))
        };
        if referenced {
            continue;
        }

        let size = fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
        if fs::remove_file(&file).is_ok() {
            result.deleted_count += 1;
            result.freed_bytes += size;
        }
    }

    // 自底向上尝试移除空目录（remove_dir 仅在目录为空时成功，失败忽略）
    for dir in dirs.iter().rev() {
        let _ = fs::remove_dir(dir);
    }

    Ok(result)
}
