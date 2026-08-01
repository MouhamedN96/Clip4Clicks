// Clip4Clicks — Rust backend
// Tauri v2 app: local rendering + VPS API sync

mod api;
mod commands;
mod db;
mod mobileuse_bridge;
#[allow(dead_code)] // The rendering checkpoint will connect this tested queue to commands.
mod queue;
mod sidecar;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Initialize local SQLite database
            let app_dir = app
                .path()
                .app_data_dir()
                .expect("failed to get app data dir");
            std::fs::create_dir_all(&app_dir)?;
            let db_path = app_dir.join("clip4clicks.db");
            let database = db::Database::init(&db_path)?;
            app.manage(database);

            // Desktop bridge: claims approved post jobs from the VPS and runs
            // them on phones attached to this machine via Mobile-Use.
            app.manage(mobileuse_bridge::BridgeState::new());

            // Check for ffmpeg/yt-dlp sidecars
            let sidecar_dir = app
                .path()
                .resource_dir()
                .expect("failed to get resource dir");
            match sidecar::check_sidecars(&sidecar_dir) {
                Ok(found) => {
                    log::info!("sidecars: ffmpeg={}, yt-dlp={}", found.ffmpeg, found.yt_dlp)
                }
                Err(e) => log::warn!("sidecar check failed: {e}"),
            }

            log::info!("Clip4Clicks initialized");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_review_queue,
            commands::approve_clip,
            commands::reject_clip,
            commands::regenerate_clip,
            commands::queue_clip,
            commands::get_clip_status,
            commands::render_clip,
            commands::upload_and_produce,
            commands::get_products,
            commands::get_analytics,
            commands::check_vps_health,
            commands::sync_with_vps,
            commands::get_settings,
            commands::save_settings,
            mobileuse_bridge::list_devices,
            mobileuse_bridge::bridge_start,
            mobileuse_bridge::bridge_stop,
            mobileuse_bridge::bridge_status,
            mobileuse_bridge::bridge_tick_once,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Clip4Clicks");
}
