// VPS API client — talks to the Clip4Clicks API on the VPS.
// Contract matches src/api/server.js:
//   GET  /health
//   GET  /api/clips/review-queue  -> { count, clips: [ {id,title,source_url,status,metadata,created_at} ] }
//   POST /api/clips/:id/approve   <- { platforms }
//   POST /api/clips/:id/reject    <- { reason }
// Auth is optional today (no middleware); the api_key is sent as a bearer token
// when set, so it keeps working once the API gains auth.

use serde::{Deserialize, Serialize};

use crate::commands::Clip;

#[derive(Serialize, Deserialize)]
pub struct VpsHealth {
    pub api_reachable: bool,
    pub farm_status: String,
    pub queue_depth: usize,
}

fn client(secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(secs))
        .build()
        .map_err(|e| e.to_string())
}

fn base(vps_url: &str) -> &str {
    vps_url.trim_end_matches('/')
}

pub async fn check_health(vps_url: &str) -> Result<VpsHealth, String> {
    let c = client(10)?;
    let url = format!("{}/health", base(vps_url));
    match c.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => Ok(VpsHealth {
            api_reachable: true,
            farm_status: "online".to_string(),
            queue_depth: 0,
        }),
        Ok(resp) => Ok(VpsHealth {
            api_reachable: false,
            farm_status: format!("http {}", resp.status().as_u16()),
            queue_depth: 0,
        }),
        Err(_) => Ok(VpsHealth {
            api_reachable: false,
            farm_status: "offline".to_string(),
            queue_depth: 0,
        }),
    }
}

// ── Review queue ──────────────────────────────────────────────

#[derive(Deserialize)]
struct ReviewQueueResp {
    #[serde(default)]
    clips: Vec<RemoteClip>,
}

#[derive(Deserialize)]
struct RemoteClip {
    id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    source_url: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    metadata: Option<serde_json::Value>,
    #[serde(default)]
    created_at: Option<String>,
}

fn map_clip(r: RemoteClip) -> Clip {
    let meta = r.metadata.unwrap_or_else(|| serde_json::json!({}));
    let platforms = meta
        .get("platforms")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect::<Vec<_>>()
        })
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| vec!["tiktok".to_string()]);

    Clip {
        id: r.id,
        title: r.title.unwrap_or_default(),
        source_url: r.source_url.unwrap_or_default(),
        status: r.status.unwrap_or_else(|| "pending_review".to_string()),
        thumbnail: meta
            .get("thumbnail")
            .and_then(|v| v.as_str())
            .map(String::from),
        duration: meta.get("duration").and_then(|v| v.as_f64()),
        platforms,
        created_at: r.created_at.unwrap_or_default(),
    }
}

pub async fn fetch_pending_clips(vps_url: &str, api_key: &str) -> Result<Vec<Clip>, String> {
    let c = client(15)?;
    let url = format!("{}/api/clips/review-queue", base(vps_url));
    let mut req = c.get(&url);
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("VPS review-queue error: {}", resp.status()));
    }
    let parsed: ReviewQueueResp = resp.json().await.map_err(|e| e.to_string())?;
    Ok(parsed.clips.into_iter().map(map_clip).collect())
}

// ── Approve / reject push ─────────────────────────────────────

pub async fn approve_clip_remote(
    vps_url: &str,
    api_key: &str,
    clip_id: &str,
    platforms: &[String],
    caption: Option<&str>,
) -> Result<(), String> {
    let c = client(15)?;
    let url = format!("{}/api/clips/{}/approve", base(vps_url), clip_id);
    // The VPS applies `caption` to the post when present; omit it entirely so the
    // server keeps falling back to the clip title rather than posting an empty one.
    let mut body = serde_json::json!({ "platforms": platforms });
    if let Some(text) = caption.map(str::trim).filter(|s| !s.is_empty()) {
        body["caption"] = serde_json::Value::String(text.to_string());
    }
    let mut req = c.post(&url).json(&body);
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("VPS approve failed: {}", resp.status()))
    }
}

pub async fn reject_clip_remote(
    vps_url: &str,
    api_key: &str,
    clip_id: &str,
    reason: &str,
) -> Result<(), String> {
    let c = client(15)?;
    let url = format!("{}/api/clips/{}/reject", base(vps_url), clip_id);
    let mut req = c.post(&url).json(&serde_json::json!({ "reason": reason }));
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("VPS reject failed: {}", resp.status()))
    }
}

// ── Local-file upload → production ────────────────────────────
// The operator picks a file on this machine; the VPS is what actually produces
// (highlight scoring + burned captions), so the bytes go up rather than the
// render coming down. Two hops, both bearer-authed:
//   POST /api/bridge/upload?filename=…  <- raw bytes  -> { sourcePath }
//   POST /api/clips/generate            <- { sourcePath, platforms }

/// Percent-encode a filename for use in a query string. Only unreserved
/// characters survive; everything else (spaces, `&`, non-ASCII) is escaped, so a
/// weird filename can't rewrite the query.
fn encode_query_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Upload raw video bytes; returns the server-side `sourcePath` to produce from.
pub async fn upload_source(
    vps_url: &str,
    api_key: &str,
    filename: &str,
    bytes: Vec<u8>,
) -> Result<String, String> {
    // Uploads are big and the link may be slow — give this its own long budget.
    let c = client(1800)?;
    let url = format!(
        "{}/api/bridge/upload?filename={}",
        base(vps_url),
        encode_query_value(filename)
    );
    let mut req = c
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "video/mp4")
        .body(bytes);
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("upload failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "upload failed: http {} {}",
            status.as_u16(),
            text.chars().take(200).collect::<String>()
        ));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("upload returned invalid JSON: {e}"))?;
    parsed
        .get("sourcePath")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .ok_or_else(|| "upload response had no sourcePath".to_string())
}

/// Ask the VPS to produce a clip from a path that already lives on the VPS.
pub async fn generate_from_source(
    vps_url: &str,
    api_key: &str,
    source_path: &str,
    platforms: &[String],
) -> Result<(), String> {
    let c = client(60)?;
    let url = format!("{}/api/clips/generate", base(vps_url));
    let mut req = c.post(&url).json(&serde_json::json!({
        "sourcePath": source_path,
        "platforms": platforms,
    }));
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("produce request failed: {e}"))?;
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    let text = resp.text().await.unwrap_or_default();
    Err(format!(
        "produce request failed: http {} {}",
        status.as_u16(),
        text.chars().take(200).collect::<String>()
    ))
}

// ── Products (VPS scaffold; not used by the operator UI yet) ───

pub async fn get_products(vps_url: &str) -> Result<serde_json::Value, String> {
    let c = client(15)?;
    let url = format!("{}/api/clips/queue", base(vps_url));
    let resp = c.get(&url).send().await.map_err(|e| e.to_string())?;
    resp.json().await.map_err(|e| e.to_string())
}
