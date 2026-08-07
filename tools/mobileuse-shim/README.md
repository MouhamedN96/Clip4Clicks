# Mobile-Use shim

Mobile-Use ships a CLI and a Python SDK. It does not serve HTTP. Both of our
clients assume it does — `src/integration/mobileuse.js` and the desktop bridge
in `src-tauri/src/mobileuse_bridge.rs` (on `wda-local`). This serves the contract
they already speak, on top of the SDK that exists.

Only `/agent` needs an LLM key. Device discovery, screenshots, the UI tree,
tap/type/swipe/open and `push` are plain ADB, so the whole bridge loop can be
proven wired before spending anything.

## Runbook

Everything below is on the operator desktop — the machine with the phones. The
VPS has none and never runs this.

### 1. Android tooling

Needs `adb` and (for a device-less proof) the emulator. No Android Studio
required. A JDK is only needed if you want `sdkmanager`/`avdmanager`; a
hand-placed SDK works without one.

```
%LOCALAPPDATA%\Android\Sdk\
  platform-tools\adb.exe
  emulator\emulator.exe
  system-images\android-34\google_apis\x86_64\
```

An AVD is two files — `avdmanager` cannot see a hand-placed SDK (no
`package.xml`), so write them directly:

```
%USERPROFILE%\.android\avd\<name>.ini          # path=, target=android-34
%USERPROFILE%\.android\avd\<name>.avd\config.ini
```

`config.ini` must carry at least `image.sysdir.1`, `abi.type=x86_64`,
`hw.cpu.arch=x86_64` and `tag.id=google_apis`.

Boot it:

```
emulator -avd <name> -no-snapshot -gpu swiftshader_indirect -no-boot-anim
```

Cold boot is 90–220 seconds and shows a **black screen for most of it**. It is
not hung. Closing the window kills the device.

### 2. Mobile-Use

```
git clone https://github.com/minitap-ai/mobile-use
cd mobile-use
uv venv && uv sync --no-dev
```

`--no-dev` on purpose: the dev extra pulls `pyright`, which we do not need.

### 3. The shim

```
cd mobile-use
.venv\Scripts\python.exe ..\clipforge-vps\tools\mobileuse-shim\server.py
```

Binds `127.0.0.1:8000`. **Do not bind it wider** — it drives a logged-in phone.

| env | default | |
|---|---|---|
| `MOBILEUSE_SHIM_HOST` | `127.0.0.1` | bind address |
| `MOBILEUSE_SHIM_PORT` | `8000` | bind port |
| `ADB_HOST` / `ADB_PORT` | `127.0.0.1:5037` | adb server |
| `MOBILEUSE_INIT_TIMEOUT` | `240` | seconds to bring an Agent up |
| `MOBILEUSE_AGENT_TIMEOUT` | `900` | seconds for one agent run |

Plus whichever LLM key Mobile-Use's profile wants (`OPENAI_API_KEY`, …). Without
one, `/agent` returns **503** and the bridge requeues the job rather than
burning it.

### 4. Prove the loop

```
VPS=http://127.0.0.1:3100 TOKEN=<API_SECRET> node e2e-proof.mjs
```

Walks the real chain: VPS produces a clip → HITL gate approves → the bridge
contract claims it → downloads it → pushes it onto the handset → MediaStore
indexes it → result reported back. The agent step is included and expected to
fail without a key; that is the honest picture.

## Reaching the VPS

The API binds `127.0.0.1` on the box, so the desktop cannot reach it as shipped.
An SSH tunnel works for a test but drops when idle:

```
ssh -N -L 3100:127.0.0.1:3000 root@<vps>
```

The real answer is `API_BIND=<tailscale-ip>` in `config/.env`, so the desktop
talks to it over the tailnet with no tunnel. Bridge endpoints are Bearer-authed
and fail closed, so tailnet exposure is the intended posture — but it is a live
change to what can reach the API, so make it deliberately.

## Known gaps

- The `google_apis` emulator image has **no gallery app and no Play Store**.
  MediaStore is the authoritative check for what a picker would see, which is
  what `e2e-proof.mjs` asserts. Driving real TikTok/Instagram needs sideloaded
  APKs or a `google_apis_playstore` image.
- Emulators are fingerprinted by those apps. Fine for building and proving the
  pipeline; real handsets for actual posting.

## Gemini setup (verified working)

`.env` in the mobile-use clone (it is gitignored there):

```
GOOGLE_API_KEY=<AI Studio key>
MOBILE_USE_TELEMETRY_ENABLED=false
```

Then `llm-config.override.jsonc` in the mobile-use root. Three traps, all of
which present as "the key doesn't work":

1. **The SDK ignores the override.** `initialize_llm_config()` merges it; the
   CLI calls that, the SDK does not — it goes straight to the defaults. The shim
   calls it and passes the result in as an `AgentProfile`.
2. **A malformed override fails silently.** `utils.video_analyzer.fallback` is
   required; omit it and `parse_llm_config` logs an error nobody sees and
   returns the all-OpenAI defaults. Also: a node with no explicit fallback keeps
   the *OpenAI* default fallback. Declare a fallback on every node.
3. **`/models` lists more than the key will serve.** On a new AI Studio key,
   `gemini-2.5-flash` and `-flash-lite` 404 with "no longer available to new
   users", and `gemini-2.5-pro` / `gemini-2.0-flash` 429 on quota. Working:
   `gemini-flash-latest`, `gemini-flash-lite-latest`, `gemini-3.5-flash`,
   `gemini-3.6-flash`, `gemini-3-flash-preview`. Verify by calling, not listing.

Mobile-Use also needs the `adb` **binary** on PATH — adbutils only needs the
server socket, but `Agent.init()` shells out.

### Free-tier quota is not an operating budget

`GenerateRequestsPerDayPerProjectPerModel-FreeTier` is **20 requests per day,
per model**. One posting run is 20–50 model calls, so the free tier is under one
post per day per model. It is enough to prove the loop and nothing more.
The quota is per *model*, so spreading roles across the five usable models
multiplies it — still only a few runs a day. Operating this needs billing
enabled or a local model.
