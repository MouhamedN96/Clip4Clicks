// Mobile-Use bridge — the desktop half of the "VPS makes videos, this machine
// owns the phones" split.
//
// The VPS renders clips and gates them behind human approval but has no phones
// attached. This module polls the VPS for approved post jobs, downloads the
// rendered mp4 locally, and drives a real Android handset through the local
// Mobile-Use HTTP agent (github.com/minitap-ai/mobile-use), then reports the
// per-platform outcome back to the VPS.
//
// VPS contract (all requests carry `Authorization: Bearer <api_key>`):
//   GET  /api/bridge/posts/claim?device=<name>  -> { job: null } | { job: {...} }
//   GET  /api/bridge/clips/<clipId>/file        -> mp4 bytes
//   POST /api/bridge/posts/<clipId>/result      <- { results: [{platform,success,error?}] }
//
// Mobile-Use contract (best-effort shapes, parsed defensively):
//   GET  /devices                     -> { devices: [{id,model,status}] }
//   POST /devices/{deviceId}/agent    <- { instruction, max_steps }
//
// Nothing here may panic: the operator app has to stay alive when the VPS or
// the Mobile-Use server is down.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Arc, Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_store::StoreExt;

// ── Public types ──────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Device {
    pub id: String,
    pub model: String,
    pub status: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct BridgeStatus {
    pub running: bool,
    pub last_poll: Option<String>,
    pub jobs_done: u32,
    pub jobs_failed: u32,
    pub mobileuse_alive: bool,
}

/// Shared bridge state. Every field is an `Arc` so the polling task can hold a
/// cheap clone while Tauri keeps the managed original.
#[derive(Clone, Default)]
pub struct BridgeState {
    running: Arc<AtomicBool>,
    /// Set while a polling task is alive; prevents a second `bridge_start` from
    /// spawning a duplicate loop.
    worker_alive: Arc<AtomicBool>,
    jobs_done: Arc<AtomicU32>,
    jobs_failed: Arc<AtomicU32>,
    mobileuse_alive: Arc<AtomicBool>,
    last_poll: Arc<Mutex<Option<String>>>,
}

impl BridgeState {
    pub fn new() -> Self {
        Self::default()
    }

    fn snapshot(&self) -> BridgeStatus {
        BridgeStatus {
            running: self.running.load(Ordering::SeqCst),
            last_poll: match self.last_poll.lock() {
                Ok(guard) => guard.clone(),
                Err(poisoned) => poisoned.into_inner().clone(),
            },
            jobs_done: self.jobs_done.load(Ordering::SeqCst),
            jobs_failed: self.jobs_failed.load(Ordering::SeqCst),
            mobileuse_alive: self.mobileuse_alive.load(Ordering::SeqCst),
        }
    }

    fn mark_poll(&self) {
        let now = chrono::Utc::now().to_rfc3339();
        match self.last_poll.lock() {
            Ok(mut guard) => *guard = Some(now),
            Err(poisoned) => *poisoned.into_inner() = Some(now),
        }
    }
}

// ── Config ────────────────────────────────────────────────────

struct BridgeConfig {
    vps_url: String,
    api_key: String,
    mobileuse_url: String,
    poll_interval_secs: u64,
    device_name: String,
    device_map: HashMap<String, String>,
}

fn store_string(app: &AppHandle, key: &str) -> Option<String> {
    // Scoped so the store handle is dropped before any `.await` in the caller.
    let store = app.store("settings.json").ok()?;
    store
        .get(key)
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|s| !s.trim().is_empty())
}

fn env_string(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.trim().is_empty())
}

/// Split `tiktok:SERIAL1,instagram:SERIAL2` into a platform -> adb serial map.
fn parse_device_map(raw: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for entry in raw.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        if let Some((platform, serial)) = entry.split_once(':') {
            let platform = platform.trim().to_lowercase();
            let serial = serial.trim().to_string();
            if !platform.is_empty() && !serial.is_empty() {
                map.insert(platform, serial);
            }
        }
    }
    map
}

fn read_config(app: &AppHandle) -> BridgeConfig {
    let vps_url = store_string(app, "vps_url")
        .or_else(|| env_string("CLIPFORGE_API_URL"))
        .unwrap_or_else(|| "http://localhost:3000".to_string());
    let api_key = store_string(app, "api_key")
        .or_else(|| env_string("CLIPFORGE_API_SECRET"))
        .unwrap_or_default();

    let host = env_string("MOBILEUSE_HOST").unwrap_or_else(|| "127.0.0.1".to_string());
    let port = env_string("MOBILEUSE_PORT").unwrap_or_else(|| "8000".to_string());

    let poll_interval_secs = env_string("BRIDGE_POLL_INTERVAL_SECS")
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(30);

    let device_name = env_string("BRIDGE_DEVICE_NAME")
        .or_else(|| store_string(app, "device_name"))
        .or_else(|| env_string("COMPUTERNAME"))
        .or_else(|| env_string("HOSTNAME"))
        .unwrap_or_else(|| "desktop".to_string());

    let device_map = env_string("MOBILEUSE_ADB_DEVICES")
        .map(|raw| parse_device_map(&raw))
        .unwrap_or_default();

    BridgeConfig {
        vps_url: vps_url.trim_end_matches('/').to_string(),
        api_key,
        mobileuse_url: format!("http://{}:{}", host, port),
        poll_interval_secs,
        device_name,
        device_map,
    }
}

// ── Small helpers ─────────────────────────────────────────────

fn client(secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(secs))
        .build()
        .map_err(|e| format!("http client build failed: {e}"))
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{:02X}", other)),
        }
    }
    out
}

fn safe_file_stem(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "clip".to_string()
    } else {
        cleaned
    }
}

/// Resolve a possibly-relative URL from the VPS against the configured base.
fn absolute_url(base: &str, maybe_relative: &str) -> String {
    if maybe_relative.starts_with("http://") || maybe_relative.starts_with("https://") {
        maybe_relative.to_string()
    } else if maybe_relative.starts_with('/') {
        format!("{}{}", base, maybe_relative)
    } else {
        format!("{}/{}", base, maybe_relative)
    }
}

fn emit_log(app: &AppHandle, level: &str, message: impl Into<String>) {
    let message = message.into();
    if level == "error" {
        log::warn!("bridge: {message}");
    } else {
        log::info!("bridge: {message}");
    }
    let _ = app.emit(
        "bridge-log",
        serde_json::json!({
            "level": level,
            "message": message,
            "ts": chrono::Utc::now().to_rfc3339(),
        }),
    );
}

fn emit_status(app: &AppHandle, state: &BridgeState) {
    let _ = app.emit("bridge-status", state.snapshot());
}

// ── VPS job model ─────────────────────────────────────────────

#[derive(Clone, Debug)]
struct PostJob {
    clip_id: String,
    caption: String,
    platforms: Vec<String>,
    store_url: Option<String>,
    utm: Option<String>,
    file_url: String,
}

fn parse_job(base: &str, body: &serde_json::Value) -> Option<PostJob> {
    let job = body.get("job")?;
    if job.is_null() {
        return None;
    }

    let clip_id = job.get("clipId").and_then(|v| v.as_str())?.to_string();
    if clip_id.is_empty() {
        return None;
    }

    let caption = job
        .get("caption")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let platforms: Vec<String> = job
        .get("platforms")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| vec!["tiktok".to_string()]);

    let store_url = job
        .get("storeUrl")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .filter(|s| !s.trim().is_empty());

    let utm = job
        .get("utm")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .filter(|s| !s.trim().is_empty());

    // `clipPath` is a VPS-side path and is deliberately ignored: the bytes must
    // come down over `fileUrl`.
    let file_url = job
        .get("fileUrl")
        .and_then(|v| v.as_str())
        .map(|s| absolute_url(base, s))
        .unwrap_or_else(|| format!("{}/api/bridge/clips/{}/file", base, url_encode(&clip_id)));

    Some(PostJob {
        clip_id,
        caption,
        platforms,
        store_url,
        utm,
        file_url,
    })
}

/// Append the tracked store link to the caption, substituting `{platform}` in
/// the UTM string.
fn build_caption(job: &PostJob, platform: &str) -> String {
    let store_url = match job.store_url.as_deref() {
        Some(url) => url,
        None => return job.caption.clone(),
    };

    let link = match job.utm.as_deref() {
        Some(utm) => {
            let utm = utm.replace("{platform}", platform);
            let sep = if store_url.contains('?') { '&' } else { '?' };
            format!("{}{}{}", store_url, sep, utm)
        }
        None => store_url.to_string(),
    };

    if job.caption.trim().is_empty() {
        link
    } else {
        format!("{}\n\n{}", job.caption, link)
    }
}

/// Natural-language task handed to the Mobile-Use agent.
fn build_instruction(platform: &str, video_path: &str, caption: &str) -> String {
    match platform {
        "instagram" => format!(
            "Open the Instagram app. Tap the + button and choose Reel. Select the video located at {video_path} from the device gallery (it is the most recent item). Tap Next until you reach the caption screen. Enter this caption exactly: {caption}. Then tap Share to publish the reel."
        ),
        "youtube" => format!(
            "Open the YouTube app. Tap the + Create button and choose Upload a video (Short). Select the video located at {video_path} from the device gallery (it is the most recent item). Continue to the details screen. Enter this text as the title and description: {caption}. Set visibility to Public, then tap Upload to publish."
        ),
        "tiktok" => format!(
            "Open the TikTok app. Tap the + button to create a new post. Tap Upload and select the video located at {video_path} from the gallery (it is the most recent item). Tap Next to continue to the caption screen. Enter this caption exactly: {caption}. Then tap Post to publish."
        ),
        other => format!(
            "Open the {other} app. Start a new video post. Select the video located at {video_path} from the device gallery (it is the most recent item). Continue to the caption or description screen. Enter this caption exactly: {caption}. Then publish the post."
        ),
    }
}

// ── VPS calls ─────────────────────────────────────────────────

async fn claim_job(cfg: &BridgeConfig) -> Result<Option<PostJob>, String> {
    let http = client(20)?;
    let url = format!(
        "{}/api/bridge/posts/claim?device={}",
        cfg.vps_url,
        url_encode(&cfg.device_name)
    );

    let mut req = http.get(&url);
    if !cfg.api_key.is_empty() {
        req = req.bearer_auth(&cfg.api_key);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("VPS claim unreachable: {e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("VPS claim body read failed: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "VPS claim failed: http {} {}",
            status.as_u16(),
            body.chars().take(200).collect::<String>()
        ));
    }

    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("VPS claim returned invalid JSON: {e}"))?;

    Ok(parse_job(&cfg.vps_url, &parsed))
}

async fn download_clip(cfg: &BridgeConfig, job: &PostJob) -> Result<PathBuf, String> {
    let http = client(300)?;
    let mut req = http.get(&job.file_url);
    if !cfg.api_key.is_empty() {
        req = req.bearer_auth(&cfg.api_key);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("clip download failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("clip download failed: http {}", status.as_u16()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("clip download read failed: {e}"))?;
    if bytes.is_empty() {
        return Err("clip download returned zero bytes".to_string());
    }

    let dir = std::env::temp_dir().join("clip4clicks");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;

    let path = dir.join(format!("{}.mp4", safe_file_stem(&job.clip_id)));
    std::fs::write(&path, &bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))?;

    Ok(path)
}

async fn report_results(
    cfg: &BridgeConfig,
    clip_id: &str,
    results: &[serde_json::Value],
) -> Result<String, String> {
    let http = client(30)?;
    let url = format!(
        "{}/api/bridge/posts/{}/result",
        cfg.vps_url,
        url_encode(clip_id)
    );

    let mut req = http
        .post(&url)
        .json(&serde_json::json!({ "results": results }));
    if !cfg.api_key.is_empty() {
        req = req.bearer_auth(&cfg.api_key);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("VPS result post failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!(
            "VPS result post failed: http {} {}",
            status.as_u16(),
            body.chars().take(200).collect::<String>()
        ));
    }

    let reported = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("status")
                .and_then(|s| s.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "unknown".to_string());

    Ok(reported)
}

// ── Mobile-Use calls ──────────────────────────────────────────

fn parse_devices(value: &serde_json::Value) -> Vec<Device> {
    // Accept `{ "devices": [...] }` or a bare array — the server has shipped both.
    let array = value
        .get("devices")
        .and_then(|d| d.as_array())
        .or_else(|| value.as_array());

    let array = match array {
        Some(a) => a,
        None => return Vec::new(),
    };

    array
        .iter()
        .filter_map(|item| {
            if let Some(id) = item.as_str() {
                return Some(Device {
                    id: id.to_string(),
                    model: String::new(),
                    status: "unknown".to_string(),
                });
            }

            let pick = |keys: &[&str]| -> Option<String> {
                keys.iter().find_map(|k| {
                    item.get(*k)
                        .and_then(|v| v.as_str())
                        .map(str::to_owned)
                        .filter(|s| !s.is_empty())
                })
            };

            let id = pick(&["id", "device_id", "deviceId", "serial", "udid", "name"])?;
            Some(Device {
                id,
                model: pick(&["model", "device_model", "product", "name"]).unwrap_or_default(),
                status: pick(&["status", "state"]).unwrap_or_else(|| "unknown".to_string()),
            })
        })
        .collect()
}

async fn fetch_devices(cfg: &BridgeConfig) -> Result<Vec<Device>, String> {
    let http = client(15)?;
    let url = format!("{}/devices", cfg.mobileuse_url.trim_end_matches('/'));

    let resp = http
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Mobile-Use unreachable at {url}: {e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Mobile-Use device list read failed: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "Mobile-Use /devices returned http {}",
            status.as_u16()
        ));
    }

    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("Mobile-Use /devices returned invalid JSON: {e}"))?;

    Ok(parse_devices(&parsed))
}

async fn run_agent(cfg: &BridgeConfig, device_id: &str, instruction: &str) -> Result<String, String> {
    // Agent runs drive a real phone and can take several minutes.
    let http = client(900)?;
    let url = format!(
        "{}/devices/{}/agent",
        cfg.mobileuse_url.trim_end_matches('/'),
        url_encode(device_id)
    );

    let resp = http
        .post(&url)
        .json(&serde_json::json!({
            "instruction": instruction,
            "max_steps": 50,
        }))
        .send()
        .await
        .map_err(|e| format!("Mobile-Use agent call failed: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();

    if status.is_success() {
        Ok(body.chars().take(1000).collect::<String>())
    } else {
        Err(format!(
            "Mobile-Use agent http {}: {}",
            status.as_u16(),
            body.chars().take(300).collect::<String>()
        ))
    }
}

fn pick_device(cfg: &BridgeConfig, platform: &str, devices: &[Device]) -> Option<String> {
    if let Some(serial) = cfg.device_map.get(platform) {
        return Some(serial.clone());
    }
    devices.first().map(|d| d.id.clone())
}

// ── The tick ──────────────────────────────────────────────────

/// Claim + execute + report exactly one job. Returns a human-readable summary.
async fn tick(app: &AppHandle, state: &BridgeState) -> Result<String, String> {
    let cfg = read_config(app);
    state.mark_poll();

    let job = match claim_job(&cfg).await {
        Ok(Some(job)) => job,
        Ok(None) => {
            emit_status(app, state);
            return Ok("no jobs available".to_string());
        }
        Err(e) => {
            emit_log(app, "error", format!("claim failed: {e}"));
            emit_status(app, state);
            return Err(e);
        }
    };

    emit_log(
        app,
        "info",
        format!(
            "claimed clip {} for {}",
            job.clip_id,
            job.platforms.join(", ")
        ),
    );

    let local_path = match download_clip(&cfg, &job).await {
        Ok(path) => path,
        Err(e) => {
            // Tell the VPS every platform failed so the job is not stuck claimed.
            let results: Vec<serde_json::Value> = job
                .platforms
                .iter()
                .map(|p| serde_json::json!({ "platform": p, "success": false, "error": e }))
                .collect();
            let _ = report_results(&cfg, &job.clip_id, &results).await;
            state.jobs_failed.fetch_add(1, Ordering::SeqCst);
            emit_log(app, "error", format!("download failed: {e}"));
            emit_status(app, state);
            return Err(e);
        }
    };
    let local_path_str = local_path.to_string_lossy().to_string();

    let devices = match fetch_devices(&cfg).await {
        Ok(devices) => {
            state.mobileuse_alive.store(true, Ordering::SeqCst);
            devices
        }
        Err(e) => {
            state.mobileuse_alive.store(false, Ordering::SeqCst);
            emit_log(app, "error", format!("Mobile-Use device list: {e}"));
            Vec::new()
        }
    };

    let mut results: Vec<serde_json::Value> = Vec::new();
    let mut succeeded = 0usize;

    for platform in &job.platforms {
        let device_id = match pick_device(&cfg, platform, &devices) {
            Some(id) => id,
            None => {
                let err = format!("no device available for {platform}");
                emit_log(app, "error", err.clone());
                results.push(
                    serde_json::json!({ "platform": platform, "success": false, "error": err }),
                );
                continue;
            }
        };

        let caption = build_caption(&job, platform);
        let instruction = build_instruction(platform, &local_path_str, &caption);

        emit_log(
            app,
            "info",
            format!("posting {} to {platform} on device {device_id}", job.clip_id),
        );

        match run_agent(&cfg, &device_id, &instruction).await {
            Ok(body) => {
                succeeded += 1;
                state.mobileuse_alive.store(true, Ordering::SeqCst);
                emit_log(
                    app,
                    "info",
                    format!("{platform}: agent finished — {}", body.replace('\n', " ")),
                );
                results.push(serde_json::json!({ "platform": platform, "success": true }));
            }
            Err(e) => {
                emit_log(app, "error", format!("{platform}: {e}"));
                results
                    .push(serde_json::json!({ "platform": platform, "success": false, "error": e }));
            }
        }
    }

    let all_ok = succeeded == job.platforms.len() && succeeded > 0;
    if all_ok {
        state.jobs_done.fetch_add(1, Ordering::SeqCst);
    } else {
        state.jobs_failed.fetch_add(1, Ordering::SeqCst);
    }

    let reported = match report_results(&cfg, &job.clip_id, &results).await {
        Ok(status) => status,
        Err(e) => {
            emit_log(app, "error", format!("result report failed: {e}"));
            "unreported".to_string()
        }
    };

    emit_status(app, state);

    let summary = format!(
        "clip {}: {}/{} platform(s) posted ({}) — VPS says {}",
        job.clip_id,
        succeeded,
        job.platforms.len(),
        job.platforms.join(", "),
        reported
    );
    emit_log(app, if all_ok { "info" } else { "error" }, summary.clone());
    Ok(summary)
}

// ── Tauri commands ────────────────────────────────────────────

#[tauri::command]
pub async fn list_devices(app: AppHandle) -> Result<Vec<Device>, String> {
    let cfg = read_config(&app);
    match fetch_devices(&cfg).await {
        Ok(devices) => {
            emit_log(&app, "info", format!("{} device(s) attached", devices.len()));
            Ok(devices)
        }
        Err(e) => {
            emit_log(&app, "error", e.clone());
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn bridge_start(app: AppHandle, state: State<'_, BridgeState>) -> Result<String, String> {
    let state = state.inner().clone();

    if state
        .worker_alive
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok("already running".to_string());
    }
    state.running.store(true, Ordering::SeqCst);

    let interval = read_config(&app).poll_interval_secs;
    let task_app = app.clone();
    let task_state = state.clone();

    tokio::spawn(async move {
        emit_log(
            &task_app,
            "info",
            format!("bridge loop started (every {interval}s)"),
        );
        emit_status(&task_app, &task_state);

        while task_state.running.load(Ordering::SeqCst) {
            match tick(&task_app, &task_state).await {
                Ok(summary) => log::info!("bridge tick: {summary}"),
                Err(e) => log::warn!("bridge tick failed: {e}"),
            }

            // Re-read the interval each cycle so env changes apply without a restart,
            // and sleep in 1s slices so `bridge_stop` is responsive.
            let interval = read_config(&task_app).poll_interval_secs;
            for _ in 0..interval {
                if !task_state.running.load(Ordering::SeqCst) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }

        task_state.worker_alive.store(false, Ordering::SeqCst);
        emit_log(&task_app, "info", "bridge loop stopped");
        emit_status(&task_app, &task_state);
    });

    Ok(format!("bridge started (polling every {interval}s)"))
}

#[tauri::command]
pub async fn bridge_stop(state: State<'_, BridgeState>) -> Result<String, String> {
    if !state.running.swap(false, Ordering::SeqCst) {
        return Ok("bridge was not running".to_string());
    }
    Ok("bridge stopping".to_string())
}

#[tauri::command]
pub async fn bridge_status(state: State<'_, BridgeState>) -> Result<BridgeStatus, String> {
    Ok(state.snapshot())
}

#[tauri::command]
pub async fn bridge_tick_once(
    app: AppHandle,
    state: State<'_, BridgeState>,
) -> Result<String, String> {
    let state = state.inner().clone();
    tick(&app, &state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_map_parses_pairs_and_ignores_junk() {
        let map = parse_device_map("tiktok:SER1, instagram:SER2 ,,broken,youtube:");
        assert_eq!(map.get("tiktok").map(String::as_str), Some("SER1"));
        assert_eq!(map.get("instagram").map(String::as_str), Some("SER2"));
        assert!(map.get("youtube").is_none());
    }

    #[test]
    fn caption_substitutes_platform_into_utm() {
        let job = PostJob {
            clip_id: "abc".into(),
            caption: "watch this".into(),
            platforms: vec!["tiktok".into()],
            store_url: Some("https://shop.example/p/1".into()),
            utm: Some("utm_source={platform}&utm_campaign=x".into()),
            file_url: "https://vps/file".into(),
        };
        let caption = build_caption(&job, "tiktok");
        assert!(caption.contains("utm_source=tiktok"));
        assert!(caption.contains("https://shop.example/p/1?utm_source=tiktok"));
    }

    #[test]
    fn null_job_is_none() {
        let body = serde_json::json!({ "job": null });
        assert!(parse_job("http://vps", &body).is_none());
    }

    #[test]
    fn relative_file_url_is_absolutised() {
        let body = serde_json::json!({
            "job": {
                "clipId": "u-1",
                "caption": "hi",
                "platforms": ["tiktok"],
                "fileUrl": "/api/bridge/clips/u-1/file"
            }
        });
        let job = parse_job("http://vps:3000", &body).expect("job");
        assert_eq!(job.file_url, "http://vps:3000/api/bridge/clips/u-1/file");
    }
}
