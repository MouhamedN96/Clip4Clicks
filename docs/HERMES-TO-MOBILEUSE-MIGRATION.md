# Architecture Migration: Hermes → Mobile-Use

> **Status:** Hermes phone farm has been replaced by Mobile-Use (github.com/minitap-ai/mobile-use).
> This document preserves the Hermes architecture for reference in case the relay approach
> is needed again in the future.

## What Changed

| Aspect | Hermes (old) | Mobile-Use (new) |
|---|---|---|
| **Phone control** | WebSocket relay to Android phones | ADB direct to real/emulator devices |
| **Cost** | Per-connection relay server | Free (self-hosted, no API costs) |
| **LLM** | Fixed (Hermes agent) | Any (DeepSeek, Ollama, local) |
| **Device fingerprints** | Relay IP shared | Real device fingerprint (better durability) |
| **Setup** | Relay server + phone clients | ADB + Mobile-Use on laptop/Tauri app |
| **Posting** | `HermesIntegration` → relay → phone | `mobileuse.js` → ADB → device → open app → post |
| **Comments** | Not built | `engagement.js` — scans comments via UI tree |
| **DMs** | Relay → phone → DM | `engagement.js` — agent types DM in-app |
| **Config** | `HERMES_RELAY_URL`, `HERMES_API_KEY` | `MOBILEUSE_HOST`, `MOBILEUSE_PORT` |

## Why Mobile-Use Replaced Hermes

1. **No per-call cost** — content operation runs daily, not occasionally. API costs add up.
2. **Real device fingerprints** — cloud/relay IPs are detectable. Real phones via ADB look human.
3. **Comment reading + reply + DM** — Hermes only posted. Mobile-Use reads UI tree → comments → replies → DMs. Replaces OpenReply too.
4. **LLM-agnostic** — can use DeepSeek, Ollama, any model. Hermes was locked to its agent.
5. **Self-hosted** — no third party seeing phone farm activity.

## If You Need Hermes Again

The relay approach is still valid for:
- Large-scale farms (48+ phones) where ADB hub management is complex
- Remote phone racks where phones aren't physically near the operator
- Cases where WebSocket relay is simpler than ADB port forwarding

To restore Hermes:
1. The original `src/integration/hermes.js` is in git history (commit before `63faa13`)
2. The env config (`HERMES_RELAY_URL`, `HERMES_API_KEY`, etc.) is documented in these docs
3. The relay server setup is in `docs/HERMES_SETUP.md` (preserved)
4. The deployment guide is in `docs/DEPLOY-SHARED-HOST.md` (preserved)

## Files That Still Reference Hermes (kept for reference)

These files still mention Hermes. They are NOT updated to Mobile-Use — they're historical reference:
- `README.md` — architecture diagram, env config, troubleshooting
- `QUICKSTART.md` — deployment steps
- `docs/OPERATE.md` — operation guide
- `docs/DEPLOY-SHARED-HOST.md` — shared host deployment
- `docs/HERMES_SETUP.md` — relay server setup (fully preserved)
- `docker-compose.prod.yml` — production compose notes
- `scripts/deploy.sh` — firewall rules (port 8766)
- `scripts/bootstrap.sh` — env prompt
- `skills/mental-models-operator/SKILL.md` — cost model reference

The **core code** (`src/`) is fully Mobile-Use. Zero Hermes references in source.
The **docs** are intentionally left as-is for historical reference.