// Tauri commands — the bridge between frontend and Rust backend
// Each command is callable from JS: invoke('command_name', { args })

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

use crate::{api, db, sidecar};

#[derive(Serialize, Deserialize)]
pub struct Clip {
    pub id: String,
    pub title: String,
    pub source_url: String,
    pub status: String,
    pub thumbnail: Option<String>,
    pub duration: Option<f64>,
    pub platforms: Vec<String>,
    pub created_at: String,
}

#[derive(Serialize, Deserialize)]
pub struct ReviewQueue {
    pub pending: Vec<Clip>,
    pub approved: Vec<Clip>,
    pub posted: Vec<Clip>,
}

#[derive(Serialize, Deserialize)]
pub struct Settings {
    pub vps_url: String,
    pub api_key: String,
    pub brand_name: String,
    pub render_local: bool,
    pub auto_sync: bool,
}

/// Read the VPS connection (url, api_key) from the settings store.
fn read_conn(app: &AppHandle) -> (String, String) {
    match app.store("settings.json") {
        Ok(store) => {
            let url = store
                .get("vps_url")
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default();
            let key = store
                .get("api_key")
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default();
            (url, key)
        }
        Err(_) => (String::new(), String::new()),
    }
}

// ── Review queue ──────────────────────────────────────────────

#[tauri::command]
pub async fn get_review_queue(db: State<'_, db::Database>) -> Result<ReviewQueue, String> {
    db.get_review_queue().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn approve_clip(
    app: AppHandle,
    db: State<'_, db::Database>,
    clip_id: String,
    platforms: Vec<String>,
    // Optional edited post text. Lets the operator fix a weak hook at approval
    // time instead of rejecting an otherwise-good render (and burning the credits
    // that produced it). None → the VPS falls back to the clip title.
    caption: Option<String>,
) -> Result<(), String> {
    // Push to the VPS (source of truth for posting) when configured. Best-effort:
    // the local decision is authoritative for the UI; a re-sync reconciles later.
    let (vps_url, api_key) = read_conn(&app);
    if !vps_url.is_empty() {
        if let Err(e) = api::approve_clip_remote(&vps_url, &api_key, &clip_id, &platforms,
                                                 caption.as_deref()).await {
            log::warn!("VPS approve push failed for {clip_id}: {e}");
        }
    }
    db.approve_clip(&clip_id, &platforms)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reject_clip(
    app: AppHandle,
    db: State<'_, db::Database>,
    clip_id: String,
    reason: String,
) -> Result<(), String> {
    let (vps_url, api_key) = read_conn(&app);
    if !vps_url.is_empty() {
        if let Err(e) = api::reject_clip_remote(&vps_url, &api_key, &clip_id, &reason).await {
            log::warn!("VPS reject push failed for {clip_id}: {e}");
        }
    }
    db.reject_clip(&clip_id, &reason).map_err(|e| e.to_string())
}

// ── Production ────────────────────────────────────────────────

#[tauri::command]
pub async fn queue_clip(
    db: State<'_, db::Database>,
    source_url: String,
    title: String,
) -> Result<String, String> {
    db.queue_clip(&source_url, &title)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_clip_status(db: State<'_, db::Database>, clip_id: String) -> Result<Clip, String> {
    db.get_clip_status(&clip_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn render_clip(clip_id: String, source_url: String) -> Result<String, String> {
    // Runs ffmpeg/yt-dlp sidecar locally
    sidecar::render(&clip_id, &source_url)
        .await
        .map_err(|e| e.to_string())
}

/// Human-readable byte size for the summary line.
fn fmt_bytes(n: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    const GB: f64 = MB * 1024.0;
    let b = n as f64;
    if b >= GB {
        format!("{:.2} GB", b / GB)
    } else if b >= MB {
        format!("{:.1} MB", b / MB)
    } else {
        format!("{:.0} KB", (b / 1024.0).max(1.0))
    }
}

/// Take footage sitting on this machine and put it through the VPS pipeline.
///
/// The desktop's local ffmpeg path is a fixed-window placeholder — no highlight
/// scoring, no captions — so a local file is uploaded and produced by the VPS
/// exactly like any other source. Bytes are read and POSTed here in Rust rather
/// than marshalled through the JS bridge: these files run to hundreds of MB.
#[tauri::command]
pub async fn upload_and_produce(
    app: AppHandle,
    path: String,
    platforms: Vec<String>,
) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("No file selected.".to_string());
    }

    let (vps_url, api_key) = read_conn(&app);
    if vps_url.trim().is_empty() {
        return Err("No VPS URL configured — set it in Settings.".to_string());
    }
    if api_key.is_empty() {
        return Err("No API key configured — set it in Settings.".to_string());
    }

    let platforms = if platforms.is_empty() {
        vec!["tiktok".to_string()]
    } else {
        platforms
    };

    let file = std::path::PathBuf::from(&path);
    let filename = file
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("upload.mp4")
        .to_string();

    let bytes = tokio::fs::read(&file)
        .await
        .map_err(|e| format!("Can't read {filename}: {e}"))?;
    if bytes.is_empty() {
        return Err(format!("{filename} is empty — nothing to upload."));
    }
    let size = bytes.len() as u64;

    let source_path = api::upload_source(&vps_url, &api_key, &filename, bytes).await?;
    api::generate_from_source(&vps_url, &api_key, &source_path, &platforms).await?;

    Ok(format!(
        "Uploaded {} → queued for production on {}",
        fmt_bytes(size),
        platforms.join(", ")
    ))
}

// ── Products (from VPS API) ───────────────────────────────────

#[tauri::command]
pub async fn get_products(vps_url: String) -> Result<serde_json::Value, String> {
    api::get_products(&vps_url).await.map_err(|e| e.to_string())
}

// ── Analytics ─────────────────────────────────────────────────

#[tauri::command]
pub async fn get_analytics(db: State<'_, db::Database>) -> Result<db::Analytics, String> {
    db.get_analytics().map_err(|e| e.to_string())
}

// ── VPS sync ──────────────────────────────────────────────────

#[tauri::command]
pub async fn check_vps_health(vps_url: String) -> Result<api::VpsHealth, String> {
    api::check_health(&vps_url).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_with_vps(
    db: State<'_, db::Database>,
    vps_url: String,
    api_key: String,
) -> Result<usize, String> {
    // Pull pending clips from VPS, store locally
    let clips = api::fetch_pending_clips(&vps_url, &api_key)
        .await
        .map_err(|e| e.to_string())?;
    let count = db.sync_clips(clips).map_err(|e| e.to_string())?;
    Ok(count)
}

// ── Settings ──────────────────────────────────────────────────

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> Result<Settings, String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    let vps_url = store
        .get("vps_url")
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "http://localhost:3000".to_string());
    let api_key = store
        .get("api_key")
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default();
    let brand_name = store
        .get("brand_name")
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "Clip4Clicks".to_string());
    let render_local = store
        .get("render_local")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let auto_sync = store
        .get("auto_sync")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    Ok(Settings {
        vps_url,
        api_key,
        brand_name,
        render_local,
        auto_sync,
    })
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    store.set("vps_url", serde_json::json!(settings.vps_url));
    store.set("api_key", serde_json::json!(settings.api_key));
    store.set("brand_name", serde_json::json!(settings.brand_name));
    store.set("render_local", serde_json::json!(settings.render_local));
    store.set("auto_sync", serde_json::json!(settings.auto_sync));
    store.save().map_err(|e| e.to_string())
}
