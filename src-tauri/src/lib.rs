mod dalle;
mod gemini;
mod llm;
mod models;
mod storage;

use dalle::*;
use gemini::*;
use llm::*;
use models::*;
use storage::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            // 启动时为自定义图片存储目录扩展 asset protocol 授权
            storage::ensure_custom_dir_asset_scope(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_image,
            read_image,
            read_image_metadata,
            delete_image,
            delete_canvas_images,
            get_storage_stats,
            clear_cache,
            clear_all_images,
            get_storage_path,
            get_storage_config,
            set_storage_config,
            migrate_images_storage,
            list_canvas_images,
            list_all_images,
            ensure_thumbnail,
            ensure_asset_paths_allowed,
            cleanup_unreferenced_images,
            list_models,
            gemini_generate_content,
            gemini_generate_text,
            // LLM 代理命令
            openai_chat_completion,
            openai_responses,
            claude_chat_completion,
            // DALL-E 图片生成命令
            dalle_generate_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
