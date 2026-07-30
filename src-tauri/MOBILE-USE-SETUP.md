# Mobile-Use Bridge Setup — Tauri Desktop App

This document explains how to set up the Tauri desktop app as the Mobile-Use bridge:
it runs Mobile-Use locally on the operator's laptop, connected to real Android phones
via USB ADB, and polls the VPS API for pending post/engagement jobs.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  VPS (Contabo)                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ API      │  │ Worker   │  │ MCP      │  │ Redis + Postgres  │  │
│  │ server.js│  │ index.js │  │ server   │  │ (queues + clips) │  │
│  └────┬─────┘  └────┬─────┘  └──────────┘  └──────────────────┘  │
│       │              │                                          │
│       │    post_queue, engagement_queue, outreach_queue          │
└───────┼──────────────┼──────────────────────────────────────────┘
        │ HTTPS/Tailscale
        │
┌───────┴──────────────────────────────────────────────────────────┐
│  Laptop (Tauri Desktop App)                                        │
│                                                                    │
│  ┌─────────────────┐     ┌──────────────────────────────────────┐ │
│  │ Tauri App        │     │ Mobile-Use (localhost:8000)           │ │
│  │ - Poll VPS API   │────▶│ - AI agent (reads UI tree, taps,     │ │
│  │ - Show queue    │     │   types, swipes)                     │ │
│  │ - Device status │     │ - ADB connection to phones           │ │
│  └─────────────────┘     └──────────┬───────────────────────────┘ │
│                                     │ USB                          │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                               │
│  │Phone1│ │Phone2│ │Phone3│ │Phone4│  (TikTok, IG, YouTube, etc.) │
│  └──────┘ └──────┘ └──────┘ └──────┘                               │
└────────────────────────────────────────────────────────────────────┘
```

## Prerequisites

### 1. Install ADB (Android Debug Bridge)

**Linux:**
```bash
sudo apt update && sudo apt install adb
```

**macOS:**
```bash
brew install android-platform-tools
```

**Windows:**
Download from https://developer.android.com/tools/releases/platform-tools
and add to PATH.

Verify:
```bash
adb version
```

### 2. Install Mobile-Use

```bash
git clone https://github.com/minitap-ai/mobile-use.git
cd mobile-use
pip install -e .
```

Or with pipx:
```bash
pipx install mobile-use
```

Mobile-Use requires Python 3.10+. It also needs an LLM API key for the agent
(e.g. OpenAI `OPENAI_API_KEY` or Anthropic `ANTHROPIC_API_KEY`). Set this in
the environment where Mobile-Use runs.

### 3. Connect Phones via USB

For each phone:
1. **Enable Developer Mode**: Settings → About Phone → tap "Build Number" 7 times
2. **Enable USB Debugging**: Settings → Developer Options → USB Debugging = ON
3. Connect the phone to the laptop via USB cable
4. On the phone, tap "Allow USB Debugging" when prompted
5. Verify the connection:

```bash
adb devices
# Should list each phone's serial number, e.g.:
# List of devices attached
# R5CR70XXXXX     device
# 192.168.1.50:5555  device
```

If a phone doesn't appear:
- Try a different USB cable (some cables are power-only)
- Try a different USB port
- Check `adb kill-server && adb start-server`
- On some phones, toggle "USB Debugging (Security Settings)" too

### 4. Start the Mobile-Use API Server

Mobile-Use includes a local HTTP API server. Start it:

```bash
cd mobile-use
python -m mobileuse serve --host 127.0.0.1 --port 8000
```

Or (if the CLI has a different invocation, check the repo):
```bash
uvicorn mobileuse.api:app --host 127.0.0.1 --port 8000
```

Verify it's running:
```bash
curl http://127.0.0.1:8000/devices
# Should return: { "devices": [...] }
```

### 5. Log Into TikTok/IG/YouTube on Each Phone (one-time)

This is a manual one-time setup per phone:
1. Open the TikTok (or Instagram / YouTube) app on the phone
2. Log in with the account credentials
3. Verify the account is in good standing (not shadowbanned)
4. Close the app — Mobile-Use will open it programmatically

**Important**: Each phone should have its own account. Don't share accounts
across phones — that fingerprints the farm and reduces durability.

### 6. Configure the Tauri App

The Tauri desktop app polls the VPS API for pending jobs and sends them to
Mobile-Use. Configure it with:

1. Set the VPS API URL (in the Tauri app settings or env):
   ```
   CLIPFORGE_API_URL=https://your-vps-domain.com
   CLIPFORGE_API_SECRET=your-api-secret
   ```

2. Set the Mobile-Use local URL:
   ```
   MOBILEUSE_HOST=127.0.0.1
   MOBILEUSE_PORT=8000
   ```

3. Set the device mapping (which phone for which platform):
   ```
   MOBILEUSE_ADB_DEVICES=tiktok:R5CR70XXXXX,instagram:192.168.1.50:5555,youtube:R5CR70YYYYY
   ```
   Use the serial numbers from `adb devices`.

4. Set the LLM key for Mobile-Use's AI agent:
   ```
   OPENAI_API_KEY=sk-...
   ```
   (or `ANTHROPIC_API_KEY` if using Claude)

### 7. Start the Tauri App

```bash
cd src-tauri
cargo tauri dev
```

The app will:
- Show connected devices and their status
- Poll the VPS API for pending post/engagement jobs
- Execute jobs via Mobile-Use on the appropriate phone
- Report results back to the VPS
- Show the job queue and execution log

## How the Bridge Works

### Posting Flow
1. VPS worker picks up a `post_queue` job (approved clip)
2. Worker calls Mobile-Use to post on the appropriate device
3. Mobile-Use's AI agent: opens TikTok → navigates to upload → selects video → types caption → posts
4. Result reported back to VPS

### Engagement Flow
1. VPS worker picks up an `engagement_queue` job
2. Worker calls Mobile-Use to scan comments on the posted clip
3. Mobile-Use reads the comment section (UI tree + AI extraction)
4. Keyword matching identifies buying-intent comments
5. Proposed replies + DMs stored in `clips.metadata.engagement.pending`
6. Human reviews via Telegram → approves/rejects
7. On approval, Mobile-Use executes the reply or DM on the device

### Rate Limiting
- **Posts**: min 15 min between posts per device (configurable via `POSTING_MIN_INTERVAL_MS`)
- **DMs**: max 5 per device per day, min 5 min between DMs (`ENGAGEMENT_MAX_DMS_PER_DAY`, `MIN_DELAY_BETWEEN_DMS_SECONDS`)
- **Golden rule #3**: Account durability > volume

## Troubleshooting

### ADB device not showing
- `adb kill-server && adb start-server`
- Try a different USB cable (data cable, not charge-only)
- Check Developer Options → USB Debugging is ON
- On Windows, install the OEM USB driver for the phone brand
- On macOS, install Android File Transfer (sometimes needed for MTP)

### Mobile-Use API not starting
- Check Python version: `python3 --version` (needs 3.10+)
- Check `pip install -e .` completed without errors
- Check for port conflicts: `lsof -i :8000`
- Try a different port: `--port 8001`

### App crashes during agent task
- Check the LLM API key is set and valid
- Check the phone screen is unlocked (Mobile-Use can't unlock)
- Check the app (TikTok/IG) is installed and logged in
- Check `MOBILEUSE_MAX_STEPS` — complex tasks may need more steps
- Look at Mobile-Use's console output for the agent's reasoning

### Rate limit warnings
- If you see `[rate-limited]` in logs, the device hit a limit
- Increase `POSTING_MIN_INTERVAL_MS` or `ENGAGEMENT_MAX_DMS_PER_DAY` if appropriate
- Remember: account durability > volume (golden rule #3)

### Phone disconnected mid-task
- Mobile-Use will return an error → the job marks as failed
- Reconnect the phone, verify `adb devices` shows it
- The VPS can re-queue the job

### Video file not found
- The clip path in the job refers to a path on the VPS
- The Tauri app must download the clip to the laptop first
- Mobile-Use needs the file to be local to the desktop
- The bridge handles this: downloads from VPS → local temp → passes to Mobile-Use

## Security Notes

- The Mobile-Use API server should ONLY listen on 127.0.0.1 (never 0.0.0.0)
- The VPS API connection should use HTTPS or Tailscale
- Phone accounts are logged in manually — never store credentials in the app
- The API secret (`CLIPFORGE_API_SECRET`) gates all VPS API access