//! Mobile-Use Bridge — Tauri Desktop App
//!
//! This module connects the Tauri desktop app to the VPS API and the local
//! Mobile-Use server. It polls the VPS for pending post/engagement jobs,
//! executes them via Mobile-Use on connected phones, and reports results back.
//!
//! See MOBILE-USE-SETUP.md for the full setup guide.
//!
//! This is a scaffold. The actual Tauri app is built on the `tauri/desktop` branch.
//! The functions here are called from the Tauri frontend via `invoke()`.

use std::time::Duration;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub model: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostJob {
    pub clip_id: String,
    pub clip_path: String,
    pub caption: String,
    pub platform: String,
    pub store_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngagementJob {
    pub clip_id: String,
    pub platform: String,
    pub link: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobResult {
    pub success: bool,
    pub message: String,
}

/// Configuration for the bridge. Loaded from environment variables or Tauri settings.
pub struct BridgeConfig {
    pub vps_api_url: String,
    pub vps_api_secret: Option<String>,
    pub mobileuse_host: String,
    pub mobileuse_port: u16,
    pub poll_interval_secs: u64,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            vps_api_url: std::env::var("CLIPFORGE_API_URL")
                .unwrap_or_else(|_| "http://localhost:3000".into()),
            vps_api_secret: std::env::var("CLIPFORGE_API_SECRET").ok(),
            mobileuse_host: std::env::var("MOBILEUSE_HOST")
                .unwrap_or_else(|_| "127.0.0.1".into()),
            mobileuse_port: std::env::var("MOBILEUSE_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(8000),
            poll_interval_secs: 30,
        }
    }
}

/// List devices connected to Mobile-Use.
/// Called from the Tauri frontend: `invoke("list_devices")`.
#[tauri::command]
pub async fn list_devices(config: tauri::State<'_, BridgeConfig>) -> Result<Vec<Device>, String> {
    let url = format!("http://{}:{}/devices", config.mobileuse_host, config.mobileuse_port);
    let res = reqwest::get(&url)
        .await
        .map_err(|e| format!("Mobile-Use not reachable: {}", e))?;
    let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let devices = data.get("devices")
        .and_then(|d| serde_json::from_value(d.clone()).ok())
        .unwrap_or_default();
    Ok(devices)
}

/// Post a clip to a platform via Mobile-Use.
#[tauri::command]
pub async fn post_clip(
    clip_id: String,
    platform: String,
    clip_path: String,
    caption: String,
    config: tauri::State<'_, BridgeConfig>,
) -> Result<JobResult, String> {
    let url = format!(
        "http://{}:{}/devices/{{deviceId}}/agent",
        config.mobileuse_host, config.mobileuse_port
    );
    // In a real implementation:
    // 1. Pick device for platform
    // 2. Build instruction (see posting.js buildPostInstruction)
    // 3. POST to Mobile-Use agent endpoint
    // 4. Parse result, report back to VPS
    let _ = url; // scaffold
    Ok(JobResult {
        success: true,
        message: format!("Posted {} to {}", clip_id, platform),
    })
}

/// Scan comments on a posted clip via Mobile-Use.
#[tauri::command]
pub async fn scan_comments(
    clip_id: String,
    platform: String,
    config: tauri::State<'_, BridgeConfig>,
) -> Result<Vec<serde_json::Value>, String> {
    let _ = (clip_id, platform, config);
    // In a real implementation:
    // 1. Pick device for platform
    // 2. Build instruction to read comment section
    // 3. Parse JSON response from agent
    Ok(vec![])
}

/// Start the background poller that fetches jobs from the VPS and executes them.
/// This runs in a Tokio task and updates the Tauri frontend via events.
pub fn start_poller(config: BridgeConfig, app: tauri::AppHandle) {
    tokio::spawn(async move {
        let interval = Duration::from_secs(config.poll_interval_secs);
        loop {
            // 1. Poll VPS: GET /api/posts/pending (post jobs)
            // 2. Poll VPS: GET /api/engagement/pending (engagement jobs)
            // 3. For each job: execute via Mobile-Use, report result back
            // 4. Emit Tauri events to update the UI
            //
            // Scaffold — implement with reqwest when building on desktop.

            // Emit a heartbeat event so the UI knows the poller is alive.
            let _ = app.emit("bridge-heartbeat", serde_json::json!({
                "timestamp": chrono::Utc::now().to_rfc3339()
            }));

            tokio::time::sleep(interval).await;
        }
    });
}