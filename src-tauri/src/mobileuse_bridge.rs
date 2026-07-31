// Mobile-Use bridge — the desktop half of the "VPS makes videos, this machine
// owns the phones" split.
//
// The VPS renders clips, gates them behind human approval, and decides what to
// say; it has no phones attached. This module drains the three queues the VPS
// defers to the desktop, driving real Android handsets through the local
// Mobile-Use HTTP agent (github.com/minitap-ai/mobile-use):
//
//   1. posts       — download the rendered mp4 and publish it
//   2. engagement  — open a posted clip and read its comment section
//   3. actions     — send human-approved replies and DMs
//
// The device side is a dumb executor. Keyword matching, buying-intent scoring
// and reply drafting all happen on the VPS; this module only ships raw comments
// up and types approved text back.
//
// VPS contract (all requests carry `Authorization: Bearer <api_key>`):
//   GET  /api/bridge/posts/claim?device=<name> -> { job: null } | { job: {...} }
//   GET  /api/bridge/clips/<clipId>/file       -> mp4 bytes
//   POST /api/bridge/posts/<clipId>/result     <- { results: [{platform,success,error?}] }
//   GET  /api/bridge/engagement/claim          -> { job: null } | { job: {...} }
//   POST /api/bridge/engagement/<clipId>/result<- { comments: [{username,text}], platform, link }
//   GET  /api/bridge/actions/claim             -> { job: null } | { job: {...} }
//   POST /api/bridge/actions/result            <- { messageId, clipId, engagementId, success, error? }
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

/// Seconds in the rolling window used for the per-device daily DM cap.
const DAY_SECS: i64 = 86_400;
/// Upper bound on rate-limited actions held in memory awaiting a retry. Past
/// this we report failure rather than grow without limit.
const MAX_PENDING_ACTIONS: usize = 50;
/// Cap on comments forwarded from a single scan.
const MAX_COMMENTS: usize = 50;
/// Recursion guard for the layered agent-output parser.
const PARSE_MAX_DEPTH: u8 = 5;

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
    pub scans_done: u32,
    pub actions_done: u32,
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
    scans_done: Arc<AtomicU32>,
    actions_done: Arc<AtomicU32>,
    /// Unix timestamps of DMs sent, keyed by device. Drives the rate limiter.
    dm_log: Arc<Mutex<HashMap<String, Vec<i64>>>>,
    /// Approved actions we claimed but could not send yet because of the DM
    /// rate limit. A claimed job is already popped off the VPS queue, so we own
    /// it until it is either sent or explicitly reported failed.
    pending_actions: Arc<Mutex<Vec<ActionJob>>>,
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
            scans_done: self.scans_done.load(Ordering::SeqCst),
            actions_done: self.actions_done.load(Ordering::SeqCst),
        }
    }

    fn mark_poll(&self) {
        let now = chrono::Utc::now().to_rfc3339();
        match self.last_poll.lock() {
            Ok(mut guard) => *guard = Some(now),
            Err(poisoned) => *poisoned.into_inner() = Some(now),
        }
    }

    /// Decide whether `device_id` may send a DM right now. Prunes expired
    /// history as a side effect. Synchronous by design: the guard must never be
    /// held across an `.await`.
    fn dm_gate_for(&self, device_id: &str, cfg: &BridgeConfig, now: i64) -> DmGate {
        let mut guard = match self.dm_log.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let history = guard.entry(device_id.to_string()).or_default();
        history.retain(|t| *t > now - DAY_SECS);
        dm_gate(history, now, cfg.max_dms_per_day, cfg.min_dm_delay_secs)
    }

    fn record_dm(&self, device_id: &str, now: i64) {
        let mut guard = match self.dm_log.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let history = guard.entry(device_id.to_string()).or_default();
        history.push(now);
        history.retain(|t| *t > now - DAY_SECS);
    }

    fn take_pending_actions(&self) -> Vec<ActionJob> {
        let mut guard = match self.pending_actions.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        std::mem::take(&mut *guard)
    }

    /// Hold a rate-limited action for a later tick. Returns false when the
    /// holding pen is full, so the caller can report failure instead of
    /// silently dropping an approved send.
    fn defer_action(&self, job: ActionJob) -> bool {
        let mut guard = match self.pending_actions.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if guard.len() >= MAX_PENDING_ACTIONS {
            return false;
        }
        guard.push(job);
        true
    }

    fn pending_action_count(&self) -> usize {
        match self.pending_actions.lock() {
            Ok(g) => g.len(),
            Err(poisoned) => poisoned.into_inner().len(),
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
    max_dms_per_day: u32,
    min_dm_delay_secs: i64,
    actions_per_tick: usize,
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

    // Account-survival knobs. Same names and defaults as the VPS worker so the
    // two halves cannot drift apart.
    let max_dms_per_day = env_string("ENGAGEMENT_MAX_DMS_PER_DAY")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(5);
    let min_dm_delay_secs = env_string("MIN_DELAY_BETWEEN_DMS_SECONDS")
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 0)
        .unwrap_or(300);

    let actions_per_tick = env_string("BRIDGE_ACTIONS_PER_TICK")
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(3);

    BridgeConfig {
        vps_url: vps_url.trim_end_matches('/').to_string(),
        api_key,
        mobileuse_url: format!("http://{}:{}", host, port),
        poll_interval_secs,
        device_name,
        device_map,
        max_dms_per_day,
        min_dm_delay_secs,
        actions_per_tick,
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

fn truncate(s: &str, max_chars: usize) -> String {
    let mut out: String = s.chars().take(max_chars).collect();
    if s.chars().count() > max_chars {
        out.push('…');
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

/// First non-empty string among `keys` on a JSON object.
fn json_str_field(item: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| {
        item.get(*k)
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    })
}

/// An id the VPS may send as a string or a bare number; null becomes None.
fn opt_id(v: &serde_json::Value, key: &str) -> Option<String> {
    match v.get(key) {
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

fn normalize_handle(raw: &str) -> String {
    raw.trim()
        .trim_matches('"')
        .trim()
        .trim_start_matches('@')
        .trim()
        .to_string()
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

// ── Rate limiting ─────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
enum DmGate {
    Allow,
    TooSoon { wait_secs: i64 },
    DailyCap { used: usize, cap: u32 },
}

/// Pure rate-limit decision over a device's DM history (unix seconds).
fn dm_gate(history: &[i64], now: i64, max_per_day: u32, min_delay_secs: i64) -> DmGate {
    let recent: Vec<i64> = history
        .iter()
        .copied()
        .filter(|t| *t > now - DAY_SECS)
        .collect();

    if recent.len() as u64 >= u64::from(max_per_day) {
        return DmGate::DailyCap {
            used: recent.len(),
            cap: max_per_day,
        };
    }

    if let Some(last) = recent.iter().copied().max() {
        let elapsed = now.saturating_sub(last);
        if elapsed < min_delay_secs {
            return DmGate::TooSoon {
                wait_secs: min_delay_secs - elapsed,
            };
        }
    }

    DmGate::Allow
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

#[derive(Clone, Debug)]
struct EngagementJob {
    clip_id: String,
    platform: String,
    device_id: Option<String>,
    clip_url: Option<String>,
    link: Option<String>,
}

#[derive(Clone, Debug)]
struct ActionJob {
    kind: String,
    message_id: Option<String>,
    clip_id: Option<String>,
    engagement_id: Option<String>,
    target_handle: String,
    target_platform: String,
    message: String,
    comment_text: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
struct Comment {
    username: String,
    text: String,
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

fn parse_engagement_job(body: &serde_json::Value) -> Option<EngagementJob> {
    let job = body.get("job")?;
    if job.is_null() {
        return None;
    }

    let clip_id = json_str_field(job, &["clipId"])?;

    Some(EngagementJob {
        clip_id,
        platform: json_str_field(job, &["platform"])
            .map(|p| p.to_lowercase())
            .unwrap_or_else(|| "tiktok".to_string()),
        device_id: json_str_field(job, &["deviceId"]),
        clip_url: json_str_field(job, &["clipUrl"]),
        link: json_str_field(job, &["link"]),
    })
}

fn parse_action_job(body: &serde_json::Value) -> Option<ActionJob> {
    let job = body.get("job")?;
    if job.is_null() {
        return None;
    }

    // Without text there is nothing to type, so the job is unusable.
    let message = json_str_field(job, &["message"])?;

    Some(ActionJob {
        kind: json_str_field(job, &["type"])
            .map(|t| t.to_lowercase())
            .unwrap_or_else(|| "reply".to_string()),
        message_id: opt_id(job, "messageId"),
        clip_id: opt_id(job, "clipId"),
        engagement_id: opt_id(job, "engagementId"),
        target_handle: json_str_field(job, &["targetHandle"])
            .map(|h| normalize_handle(&h))
            .unwrap_or_default(),
        target_platform: json_str_field(job, &["targetPlatform"])
            .map(|p| p.to_lowercase())
            .unwrap_or_else(|| "tiktok".to_string()),
        message,
        comment_text: job.get("comment").and_then(|c| json_str_field(c, &["text"])),
    })
}

// ── Agent output parsing ──────────────────────────────────────

/// Words that look like a handle before a colon but are really prose labels.
const LINE_STOPWORDS: &[&str] = &[
    "note",
    "notes",
    "warning",
    "error",
    "result",
    "results",
    "output",
    "comment",
    "comments",
    "summary",
    "step",
    "steps",
    "action",
    "actions",
    "url",
    "http",
    "https",
    "total",
    "found",
    "task",
    "answer",
    "username",
    "text",
];

fn comment_from_object(item: &serde_json::Value) -> Option<Comment> {
    let text = json_str_field(item, &["text", "comment", "message", "body", "content"])?;
    let username =
        json_str_field(item, &["username", "user", "author", "handle", "name", "from"])
            .unwrap_or_default();
    Some(Comment {
        username: normalize_handle(&username),
        text,
    })
}

/// Last-resort parse of one line of prose, e.g. `@aya: how much is this?`.
fn parse_comment_line(line: &str) -> Option<Comment> {
    let line = line
        .trim()
        .trim_start_matches(|c: char| c == '-' || c == '*' || c == '•')
        .trim();

    // Drop a leading "1." / "2)" enumerator.
    let line = match line.find(|c: char| !c.is_ascii_digit()) {
        Some(idx) if idx > 0 && matches!(line[idx..].chars().next(), Some('.') | Some(')')) => {
            line[idx + 1..].trim()
        }
        _ => line,
    };

    let (left, right) = match line.split_once(':') {
        Some(pair) => pair,
        None => line.split_once(" - ")?,
    };

    let username = normalize_handle(left);
    let text = right.trim().trim_matches('"').trim().to_string();

    if username.is_empty() || text.is_empty() {
        return None;
    }
    // Real handles have no spaces; this is what rejects prose like
    // "Here are the comments I found: ...".
    if username.chars().any(char::is_whitespace) || username.chars().count() > 40 {
        return None;
    }
    if LINE_STOPWORDS.contains(&username.to_lowercase().as_str()) {
        return None;
    }

    Some(Comment { username, text })
}

fn extract_json_array(s: &str) -> Option<&str> {
    let start = s.find('[')?;
    let end = s.rfind(']')?;
    if end > start {
        Some(&s[start..=end])
    } else {
        None
    }
}

fn comments_from_value(v: &serde_json::Value, depth: u8) -> Vec<Comment> {
    if depth > PARSE_MAX_DEPTH {
        return Vec::new();
    }

    match v {
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|item| match item {
                serde_json::Value::String(s) => parse_comment_line(s),
                other => comment_from_object(other),
            })
            .collect(),
        serde_json::Value::Object(_) => {
            // The agent usually wraps its answer; unwrap the common envelopes
            // before giving up.
            for key in [
                "comments",
                "data",
                "items",
                "results",
                "result",
                "output",
                "response",
                "content",
                "message",
                "text",
                "answer",
                "final_answer",
            ] {
                if let Some(child) = v.get(key) {
                    let found = match child {
                        serde_json::Value::String(s) => parse_comments_str(s, depth + 1),
                        other => comments_from_value(other, depth + 1),
                    };
                    if !found.is_empty() {
                        return found;
                    }
                }
            }
            comment_from_object(v).map(|c| vec![c]).unwrap_or_default()
        }
        serde_json::Value::String(s) => parse_comments_str(s, depth + 1),
        _ => Vec::new(),
    }
}

fn parse_comments_str(raw: &str, depth: u8) -> Vec<Comment> {
    if depth > PARSE_MAX_DEPTH {
        return Vec::new();
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    // 1. the whole payload is JSON.
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        match &v {
            serde_json::Value::String(inner) => {
                if inner != trimmed {
                    let found = parse_comments_str(inner, depth + 1);
                    if !found.is_empty() {
                        return found;
                    }
                }
            }
            other => {
                let found = comments_from_value(other, depth + 1);
                if !found.is_empty() {
                    return found;
                }
            }
        }
    }

    // 2. a JSON array embedded in prose or a ``` fence.
    if let Some(slice) = extract_json_array(trimmed) {
        if slice != trimmed {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(slice) {
                let found = comments_from_value(&v, depth + 1);
                if !found.is_empty() {
                    return found;
                }
            }
        }
    }

    // 3. line by line.
    trimmed.lines().filter_map(parse_comment_line).collect()
}

/// Turn free-form agent output into comments. Returns an empty vec rather than
/// an error when nothing can be extracted — an empty scan is a valid result.
fn parse_comments(raw: &str) -> Vec<Comment> {
    let mut out: Vec<Comment> = Vec::new();
    for c in parse_comments_str(raw, 0) {
        if !out.iter().any(|e| e.username == c.username && e.text == c.text) {
            out.push(c);
        }
        if out.len() >= MAX_COMMENTS {
            break;
        }
    }
    out
}

// ── Instructions ──────────────────────────────────────────────

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

fn build_scan_instruction(platform: &str, clip_url: Option<&str>) -> String {
    let open = match clip_url {
        Some(url) if !url.trim().is_empty() => format!("Open this link on the device: {url}."),
        _ => match platform {
            "instagram" => "Open the Instagram app, go to your own profile, and open the most recent Reel you posted.".to_string(),
            "youtube" => "Open the YouTube app, go to Your videos, and open the most recent Short you posted.".to_string(),
            other => format!("Open the {other} app, go to your own profile, and open the most recent video you posted."),
        },
    };

    format!(
        "{open} Open the comment section and scroll slowly through it so the comments load. Read every comment you can see, including each commenter's username. This is a read-only task: do not reply, do not like, and do not follow anyone. Return ONLY a JSON array like [{{\"username\":\"someone\",\"text\":\"their comment\"}}] containing the comments you read, with no other text before or after it. If there are no comments, return exactly []."
    )
}

fn build_reply_instruction(
    platform: &str,
    handle: &str,
    comment_text: Option<&str>,
    message: &str,
) -> String {
    let target = match comment_text {
        Some(text) if !text.trim().is_empty() => {
            format!("the comment from @{handle} that says \"{}\"", text.trim())
        }
        _ => format!("the comment from @{handle}"),
    };

    format!(
        "Open the {platform} app, go to your own profile, and open the most recent video you posted. Open its comment section and find {target}. Tap Reply on that comment. Type exactly this reply and nothing else: {message}. Then send the reply. Do not send anything else."
    )
}

fn build_dm_instruction(platform: &str, handle: &str, message: &str) -> String {
    format!(
        "Open the {platform} app and go to the direct messages inbox. Start a direct message to the user @{handle} (search for that exact username if you need to). Type exactly this message and nothing else: {message}. Then send it. Do not send anything else and do not message anyone else."
    )
}

// ── VPS calls ─────────────────────────────────────────────────

/// GET a `{ "job": ... }` envelope and hand the parsed body to `parse`.
async fn claim<T>(
    cfg: &BridgeConfig,
    url: String,
    label: &str,
    parse: impl Fn(&serde_json::Value) -> Option<T>,
) -> Result<Option<T>, String> {
    let http = client(20)?;
    let mut req = http.get(&url);
    if !cfg.api_key.is_empty() {
        req = req.bearer_auth(&cfg.api_key);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("VPS {label} claim unreachable: {e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("VPS {label} claim body read failed: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "VPS {label} claim failed: http {} {}",
            status.as_u16(),
            truncate(&body, 200)
        ));
    }

    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("VPS {label} claim returned invalid JSON: {e}"))?;

    Ok(parse(&parsed))
}

async fn claim_job(cfg: &BridgeConfig) -> Result<Option<PostJob>, String> {
    let url = format!(
        "{}/api/bridge/posts/claim?device={}",
        cfg.vps_url,
        url_encode(&cfg.device_name)
    );
    let base = cfg.vps_url.clone();
    claim(cfg, url, "post", |v| parse_job(&base, v)).await
}

async fn claim_engagement_job(cfg: &BridgeConfig) -> Result<Option<EngagementJob>, String> {
    let url = format!("{}/api/bridge/engagement/claim", cfg.vps_url);
    claim(cfg, url, "engagement", parse_engagement_job).await
}

async fn claim_action_job(cfg: &BridgeConfig) -> Result<Option<ActionJob>, String> {
    let url = format!("{}/api/bridge/actions/claim", cfg.vps_url);
    claim(cfg, url, "action", parse_action_job).await
}

/// POST a JSON body and return the `status` field the VPS echoes back.
async fn post_result(
    cfg: &BridgeConfig,
    url: String,
    label: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let http = client(30)?;
    let mut req = http.post(&url).json(&body);
    if !cfg.api_key.is_empty() {
        req = req.bearer_auth(&cfg.api_key);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("VPS {label} post failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!(
            "VPS {label} post failed: http {} {}",
            status.as_u16(),
            truncate(&text, 200)
        ));
    }

    Ok(serde_json::from_str::<serde_json::Value>(&text).unwrap_or(serde_json::Value::Null))
}

fn status_of(v: &serde_json::Value) -> String {
    v.get("status")
        .and_then(|s| s.as_str())
        .unwrap_or("unknown")
        .to_string()
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
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;

    let path = dir.join(format!("{}.mp4", safe_file_stem(&job.clip_id)));
    std::fs::write(&path, &bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))?;

    Ok(path)
}

async fn report_results(
    cfg: &BridgeConfig,
    clip_id: &str,
    results: &[serde_json::Value],
) -> Result<String, String> {
    let url = format!(
        "{}/api/bridge/posts/{}/result",
        cfg.vps_url,
        url_encode(clip_id)
    );
    let v = post_result(cfg, url, "post result", serde_json::json!({ "results": results })).await?;
    Ok(status_of(&v))
}

async fn report_engagement(
    cfg: &BridgeConfig,
    job: &EngagementJob,
    comments: &[Comment],
) -> Result<String, String> {
    let url = format!(
        "{}/api/bridge/engagement/{}/result",
        cfg.vps_url,
        url_encode(&job.clip_id)
    );
    let body = serde_json::json!({
        "comments": comments,
        "platform": job.platform,
        "link": job.link,
    });
    let v = post_result(cfg, url, "engagement result", body).await?;

    let num = |k: &str| v.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    Ok(format!(
        "{} (scanned {}, matched {}, proposed {})",
        status_of(&v),
        num("scanned"),
        num("matched"),
        num("proposed")
    ))
}

async fn report_action(
    cfg: &BridgeConfig,
    job: &ActionJob,
    success: bool,
    error: Option<&str>,
) -> Result<String, String> {
    let url = format!("{}/api/bridge/actions/result", cfg.vps_url);

    // Echo back whichever identity fields the job carried so the VPS can find
    // the right record.
    let mut body = serde_json::json!({
        "messageId": job.message_id,
        "clipId": job.clip_id,
        "engagementId": job.engagement_id,
        "success": success,
    });
    if let Some(err) = error {
        if let Some(map) = body.as_object_mut() {
            map.insert("error".to_string(), serde_json::json!(err));
        }
    }

    let v = post_result(cfg, url, "action result", body).await?;
    Ok(status_of(&v))
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

async fn run_agent(
    cfg: &BridgeConfig,
    device_id: &str,
    instruction: &str,
) -> Result<String, String> {
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
        // Generous cap: a comment scan returns its payload in this body.
        Ok(truncate(&body, 8000))
    } else {
        Err(format!(
            "Mobile-Use agent http {}: {}",
            status.as_u16(),
            truncate(&body, 300)
        ))
    }
}

fn pick_device(cfg: &BridgeConfig, platform: &str, devices: &[Device]) -> Option<String> {
    if let Some(serial) = cfg.device_map.get(platform) {
        return Some(serial.clone());
    }
    devices.first().map(|d| d.id.clone())
}

// ── Stage 1: posts ────────────────────────────────────────────

async fn tick_posts(
    app: &AppHandle,
    state: &BridgeState,
    cfg: &BridgeConfig,
    devices: &[Device],
) -> Result<String, String> {
    let job = match claim_job(cfg).await {
        Ok(Some(job)) => job,
        Ok(None) => return Ok("posts idle".to_string()),
        Err(e) => {
            emit_log(app, "error", format!("claim failed: {e}"));
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

    let local_path = match download_clip(cfg, &job).await {
        Ok(path) => path,
        Err(e) => {
            // Tell the VPS every platform failed so the job is not stuck claimed.
            let results: Vec<serde_json::Value> = job
                .platforms
                .iter()
                .map(|p| serde_json::json!({ "platform": p, "success": false, "error": e }))
                .collect();
            let _ = report_results(cfg, &job.clip_id, &results).await;
            state.jobs_failed.fetch_add(1, Ordering::SeqCst);
            emit_log(app, "error", format!("download failed: {e}"));
            return Err(e);
        }
    };
    let local_path_str = local_path.to_string_lossy().to_string();

    let mut results: Vec<serde_json::Value> = Vec::new();
    let mut succeeded = 0usize;

    for platform in &job.platforms {
        let device_id = match pick_device(cfg, platform, devices) {
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

        match run_agent(cfg, &device_id, &instruction).await {
            Ok(body) => {
                succeeded += 1;
                emit_log(
                    app,
                    "info",
                    format!(
                        "{platform}: agent finished — {}",
                        truncate(&body.replace('\n', " "), 300)
                    ),
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

    let reported = match report_results(cfg, &job.clip_id, &results).await {
        Ok(status) => status,
        Err(e) => {
            emit_log(app, "error", format!("result report failed: {e}"));
            "unreported".to_string()
        }
    };

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

// ── Stage 2: engagement scans ─────────────────────────────────

async fn tick_engagement(
    app: &AppHandle,
    state: &BridgeState,
    cfg: &BridgeConfig,
    devices: &[Device],
) -> Result<String, String> {
    let job = match claim_engagement_job(cfg).await {
        Ok(Some(job)) => job,
        Ok(None) => return Ok("scans idle".to_string()),
        Err(e) => {
            emit_log(app, "error", format!("engagement claim failed: {e}"));
            return Err(e);
        }
    };

    let device_id = match job
        .device_id
        .clone()
        .or_else(|| pick_device(cfg, &job.platform, devices))
    {
        Some(id) => id,
        None => {
            let err = format!("no device available for {}", job.platform);
            emit_log(app, "error", err.clone());
            // Report an empty scan anyway so the VPS releases the claim.
            let _ = report_engagement(cfg, &job, &[]).await;
            return Err(err);
        }
    };

    emit_log(
        app,
        "info",
        format!(
            "scanning comments on {} ({}) via device {device_id}",
            job.clip_id, job.platform
        ),
    );

    let instruction = build_scan_instruction(&job.platform, job.clip_url.as_deref());
    let comments = match run_agent(cfg, &device_id, &instruction).await {
        Ok(body) => {
            state.scans_done.fetch_add(1, Ordering::SeqCst);
            let parsed = parse_comments(&body);
            if parsed.is_empty() {
                emit_log(
                    app,
                    "info",
                    format!(
                        "scan of {} produced no parseable comments — {}",
                        job.clip_id,
                        truncate(&body.replace('\n', " "), 200)
                    ),
                );
            }
            parsed
        }
        Err(e) => {
            // An empty result still has to go up so the job is not stuck.
            emit_log(app, "error", format!("comment scan failed: {e}"));
            Vec::new()
        }
    };

    // Raw comments only. Matching and drafting are the VPS's job.
    let reported = report_engagement(cfg, &job, &comments).await?;

    let summary = format!(
        "scan {}: {} comment(s) → VPS says {}",
        job.clip_id,
        comments.len(),
        reported
    );
    emit_log(app, "info", summary.clone());
    Ok(summary)
}

// ── Stage 3: approved actions ─────────────────────────────────

enum ActionOutcome {
    Sent,
    Failed,
    /// Rate-limited. Not a failure: the caller holds it for a later tick.
    Deferred,
}

async fn execute_action(
    app: &AppHandle,
    state: &BridgeState,
    cfg: &BridgeConfig,
    devices: &[Device],
    job: &ActionJob,
) -> ActionOutcome {
    let device_id = match pick_device(cfg, &job.target_platform, devices) {
        Some(id) => id,
        None => {
            let err = format!("no device available for {}", job.target_platform);
            emit_log(app, "error", err.clone());
            let _ = report_action(cfg, job, false, Some(&err)).await;
            return ActionOutcome::Failed;
        }
    };

    let instruction = match job.kind.as_str() {
        "dm" => {
            if job.target_handle.is_empty() {
                let err = "dm job has no targetHandle".to_string();
                emit_log(app, "error", err.clone());
                let _ = report_action(cfg, job, false, Some(&err)).await;
                return ActionOutcome::Failed;
            }

            // Account-survival guard. A rate-limited DM is neither dropped nor
            // reported failed — it is held and retried on a later tick.
            match state.dm_gate_for(&device_id, cfg, chrono::Utc::now().timestamp()) {
                DmGate::Allow => {}
                DmGate::TooSoon { wait_secs } => {
                    emit_log(
                        app,
                        "info",
                        format!(
                            "DM to @{} held: {wait_secs}s until device {device_id} may send again",
                            job.target_handle
                        ),
                    );
                    return ActionOutcome::Deferred;
                }
                DmGate::DailyCap { used, cap } => {
                    emit_log(
                        app,
                        "info",
                        format!(
                            "DM to @{} held: device {device_id} is at its daily cap ({used}/{cap})",
                            job.target_handle
                        ),
                    );
                    return ActionOutcome::Deferred;
                }
            }

            build_dm_instruction(&job.target_platform, &job.target_handle, &job.message)
        }
        "reply" => build_reply_instruction(
            &job.target_platform,
            &job.target_handle,
            job.comment_text.as_deref(),
            &job.message,
        ),
        other => {
            let err = format!("unsupported action type '{other}'");
            emit_log(app, "error", err.clone());
            let _ = report_action(cfg, job, false, Some(&err)).await;
            return ActionOutcome::Failed;
        }
    };

    emit_log(
        app,
        "info",
        format!(
            "sending {} to @{} on {} via device {device_id}",
            job.kind, job.target_handle, job.target_platform
        ),
    );

    match run_agent(cfg, &device_id, &instruction).await {
        Ok(body) => {
            if job.kind == "dm" {
                state.record_dm(&device_id, chrono::Utc::now().timestamp());
            }
            state.actions_done.fetch_add(1, Ordering::SeqCst);
            emit_log(
                app,
                "info",
                format!(
                    "{} to @{} sent — {}",
                    job.kind,
                    job.target_handle,
                    truncate(&body.replace('\n', " "), 200)
                ),
            );
            if let Err(e) = report_action(cfg, job, true, None).await {
                emit_log(app, "error", format!("action result report failed: {e}"));
            }
            ActionOutcome::Sent
        }
        Err(e) => {
            emit_log(
                app,
                "error",
                format!("{} to @{} failed: {e}", job.kind, job.target_handle),
            );
            let _ = report_action(cfg, job, false, Some(&e)).await;
            ActionOutcome::Failed
        }
    }
}

async fn tick_actions(
    app: &AppHandle,
    state: &BridgeState,
    cfg: &BridgeConfig,
    devices: &[Device],
) -> Result<String, String> {
    let mut budget = cfg.actions_per_tick;
    let mut sent = 0usize;
    let mut failed = 0usize;
    let mut deferred = 0usize;
    let mut claim_error: Option<String> = None;

    // Retries first. These were claimed on an earlier tick and are already off
    // the VPS queue, so we owe them a send.
    let mut queue = state.take_pending_actions();
    queue.reverse(); // pop() then yields them oldest-first
    let mut carried: Vec<ActionJob> = Vec::new();

    loop {
        let job = match queue.pop() {
            Some(j) => j,
            None => {
                if budget == 0 {
                    break;
                }
                match claim_action_job(cfg).await {
                    Ok(Some(j)) => j,
                    Ok(None) => break,
                    Err(e) => {
                        emit_log(app, "error", format!("action claim failed: {e}"));
                        claim_error = Some(e);
                        break;
                    }
                }
            }
        };

        if budget == 0 {
            carried.push(job);
            continue;
        }

        match execute_action(app, state, cfg, devices, &job).await {
            ActionOutcome::Sent => {
                sent += 1;
                budget -= 1;
            }
            ActionOutcome::Failed => {
                failed += 1;
                budget -= 1;
            }
            ActionOutcome::Deferred => carried.push(job),
        }
    }

    for job in carried {
        if state.defer_action(job.clone()) {
            deferred += 1;
        } else {
            // Holding pen is full. Never lose an approved send silently: tell
            // the VPS it failed so a human can re-approve it.
            let err = format!("dropped: bridge retry queue is full ({MAX_PENDING_ACTIONS})");
            emit_log(app, "error", err.clone());
            let _ = report_action(cfg, &job, false, Some(&err)).await;
            failed += 1;
        }
    }

    let held = state.pending_action_count();
    let summary = format!("actions: {sent} sent, {failed} failed, {deferred} held ({held} waiting)");
    if sent > 0 || failed > 0 || deferred > 0 {
        emit_log(
            app,
            if failed > 0 { "error" } else { "info" },
            summary.clone(),
        );
    }

    match claim_error {
        Some(e) if sent == 0 && failed == 0 && deferred == 0 => Err(e),
        _ => Ok(summary),
    }
}

// ── The tick ──────────────────────────────────────────────────

/// Drain all three queues once: posts, then engagement scans, then approved
/// actions. Stages are independent — a failure in one never aborts the others.
async fn tick(app: &AppHandle, state: &BridgeState) -> Result<String, String> {
    let cfg = read_config(app);
    state.mark_poll();

    // One device probe per tick, shared by every stage. It keeps
    // `mobileuse_alive` honest even on idle ticks, and stops us claiming work
    // we have no phone to execute (a claimed job is already off the VPS queue).
    let devices = match fetch_devices(&cfg).await {
        Ok(devices) => {
            state.mobileuse_alive.store(true, Ordering::SeqCst);
            devices
        }
        Err(e) => {
            state.mobileuse_alive.store(false, Ordering::SeqCst);
            emit_log(app, "error", format!("Mobile-Use device list: {e}"));
            emit_status(app, state);
            return Err(e);
        }
    };

    if devices.is_empty() && cfg.device_map.is_empty() {
        let err = "no phones attached — nothing claimed this tick".to_string();
        emit_log(app, "error", err.clone());
        emit_status(app, state);
        return Err(err);
    }

    let mut parts: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    match tick_posts(app, state, &cfg, &devices).await {
        Ok(s) => parts.push(s),
        Err(e) => errors.push(format!("posts: {e}")),
    }
    match tick_engagement(app, state, &cfg, &devices).await {
        Ok(s) => parts.push(s),
        Err(e) => errors.push(format!("engagement: {e}")),
    }
    match tick_actions(app, state, &cfg, &devices).await {
        Ok(s) => parts.push(s),
        Err(e) => errors.push(format!("actions: {e}")),
    }

    emit_status(app, state);

    if parts.is_empty() {
        return Err(errors.join("; "));
    }

    let mut summary = parts.join(" | ");
    if !errors.is_empty() {
        summary.push_str(&format!(" | errors: {}", errors.join("; ")));
    }
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

    // ── existing coverage ─────────────────────────────────────

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

    // ── DM rate limiting ──────────────────────────────────────

    #[test]
    fn dm_gate_allows_first_send() {
        assert_eq!(dm_gate(&[], 10_000, 5, 300), DmGate::Allow);
    }

    #[test]
    fn dm_gate_blocks_until_min_delay_elapses() {
        // 100s after the last DM, with a 300s floor.
        assert_eq!(
            dm_gate(&[9_900], 10_000, 5, 300),
            DmGate::TooSoon { wait_secs: 200 }
        );
        // 300s after: the floor is satisfied.
        assert_eq!(dm_gate(&[9_700], 10_000, 5, 300), DmGate::Allow);
    }

    #[test]
    fn dm_gate_enforces_daily_cap() {
        let history = [1_000, 2_000, 3_000, 4_000, 5_000];
        assert_eq!(
            dm_gate(&history, 10_000, 5, 300),
            DmGate::DailyCap { used: 5, cap: 5 }
        );
    }

    #[test]
    fn dm_gate_ignores_sends_older_than_a_day() {
        // Five sends, all more than 24h ago, plus nothing recent.
        let now = 500_000;
        let history = [1_000, 2_000, 3_000, 4_000, 5_000];
        assert_eq!(dm_gate(&history, now, 5, 300), DmGate::Allow);
    }

    #[test]
    fn dm_gate_daily_cap_takes_priority_over_delay() {
        // At the cap and also inside the delay window: report the cap.
        let history = [9_000, 9_200, 9_400, 9_600, 9_990];
        assert_eq!(
            dm_gate(&history, 10_000, 5, 300),
            DmGate::DailyCap { used: 5, cap: 5 }
        );
    }

    // ── comment parsing ───────────────────────────────────────

    #[test]
    fn comments_parse_from_clean_json() {
        let out = parse_comments(r#"[{"username":"aya","text":"how much is this?"}]"#);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].username, "aya");
        assert_eq!(out[0].text, "how much is this?");
    }

    #[test]
    fn comments_parse_from_wrapped_agent_envelope() {
        // Mobile-Use wraps the answer, and the answer is itself a JSON string.
        let body = serde_json::json!({
            "result": "[{\"username\":\"@bo\",\"text\":\"where to buy\"}]"
        })
        .to_string();
        let out = parse_comments(&body);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].username, "bo"); // leading @ normalised away
        assert_eq!(out[0].text, "where to buy");
    }

    #[test]
    fn comments_parse_from_array_embedded_in_prose() {
        let raw = "Sure! Here is what I found:\n```json\n[{\"username\":\"cy\",\"text\":\"link?\"}]\n```\nLet me know if you need more.";
        let out = parse_comments(raw);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].username, "cy");
    }

    #[test]
    fn comments_fall_back_to_line_parsing() {
        let raw = "- @aya: how much is this?\n2. bo - where do I buy\n@cy: link please";
        let out = parse_comments(raw);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].username, "aya");
        assert_eq!(out[1].username, "bo");
        assert_eq!(out[2].username, "cy");
    }

    #[test]
    fn prose_only_output_yields_no_comments() {
        let raw = "Note: I could not open the comment section.\nWarning: the app crashed twice.\nHere are the comments I found: none at all";
        assert!(parse_comments(raw).is_empty());
    }

    #[test]
    fn empty_json_array_yields_no_comments() {
        assert!(parse_comments("[]").is_empty());
        assert!(parse_comments("").is_empty());
        assert!(parse_comments("   \n  ").is_empty());
    }

    #[test]
    fn comments_are_deduplicated_and_capped() {
        let dup = r#"[{"username":"a","text":"x"},{"username":"a","text":"x"}]"#;
        assert_eq!(parse_comments(dup).len(), 1);

        let many: Vec<serde_json::Value> = (0..80)
            .map(|i| serde_json::json!({ "username": format!("u{i}"), "text": "hi" }))
            .collect();
        let out = parse_comments(&serde_json::json!(many).to_string());
        assert_eq!(out.len(), MAX_COMMENTS);
    }

    #[test]
    fn comment_entries_without_text_are_skipped() {
        let raw = r#"[{"username":"a"},{"username":"b","text":"real"}]"#;
        let out = parse_comments(raw);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].username, "b");
    }

    // ── job parsing ───────────────────────────────────────────

    #[test]
    fn engagement_job_parses_and_handles_nulls() {
        assert!(parse_engagement_job(&serde_json::json!({ "job": null })).is_none());

        let body = serde_json::json!({
            "job": {
                "clipId": "c-1",
                "platform": "TikTok",
                "deviceId": null,
                "clipUrl": null,
                "link": "https://shop.example/p/1"
            }
        });
        let job = parse_engagement_job(&body).expect("job");
        assert_eq!(job.clip_id, "c-1");
        assert_eq!(job.platform, "tiktok"); // lowercased
        assert!(job.device_id.is_none());
        assert!(job.clip_url.is_none());
        assert_eq!(job.link.as_deref(), Some("https://shop.example/p/1"));
    }

    #[test]
    fn action_job_parses_dm_with_null_identity_fields() {
        let body = serde_json::json!({
            "job": {
                "type": "dm",
                "messageId": "m-1",
                "clipId": null,
                "engagementId": null,
                "targetHandle": "@aya",
                "targetPlatform": "TikTok",
                "message": "hey! it's $29 — link in bio",
                "comment": null
            }
        });
        let job = parse_action_job(&body).expect("job");
        assert_eq!(job.kind, "dm");
        assert_eq!(job.message_id.as_deref(), Some("m-1"));
        assert!(job.clip_id.is_none());
        assert!(job.engagement_id.is_none());
        assert_eq!(job.target_handle, "aya"); // @ stripped
        assert_eq!(job.target_platform, "tiktok");
        assert!(job.comment_text.is_none());
    }

    #[test]
    fn action_job_carries_comment_text_for_replies() {
        let body = serde_json::json!({
            "job": {
                "type": "reply",
                "messageId": null,
                "clipId": "c-9",
                "engagementId": "e-9",
                "targetHandle": "bo",
                "targetPlatform": "instagram",
                "message": "$29, link in bio!",
                "comment": { "username": "bo", "text": "how much?" }
            }
        });
        let job = parse_action_job(&body).expect("job");
        assert_eq!(job.kind, "reply");
        assert_eq!(job.clip_id.as_deref(), Some("c-9"));
        assert_eq!(job.engagement_id.as_deref(), Some("e-9"));
        assert_eq!(job.comment_text.as_deref(), Some("how much?"));

        let instruction = build_reply_instruction(
            &job.target_platform,
            &job.target_handle,
            job.comment_text.as_deref(),
            &job.message,
        );
        assert!(instruction.contains("how much?"));
        assert!(instruction.contains("$29, link in bio!"));
    }

    #[test]
    fn action_job_without_message_is_rejected() {
        let body = serde_json::json!({
            "job": { "type": "dm", "targetHandle": "aya", "targetPlatform": "tiktok" }
        });
        assert!(parse_action_job(&body).is_none());
        assert!(parse_action_job(&serde_json::json!({ "job": null })).is_none());
    }

    #[test]
    fn scan_instruction_demands_json_and_stays_read_only() {
        let with_url = build_scan_instruction("tiktok", Some("https://tiktok.com/@x/video/1"));
        assert!(with_url.contains("https://tiktok.com/@x/video/1"));
        assert!(with_url.contains("JSON array"));
        assert!(with_url.contains("do not reply"));

        let without_url = build_scan_instruction("instagram", None);
        assert!(without_url.contains("Instagram"));
        assert!(without_url.contains("[]"));
    }
}
