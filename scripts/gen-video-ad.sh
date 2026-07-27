#!/usr/bin/env bash
# Generate a short vertical video via fal Seedance 2.0 (native audio, 9:16).
#
#   - With a reference image  -> product ad (image_urls -> reference-to-video)
#   - With "-" as the image   -> text-only hero (text-to-video)
#
# Reads FAL_KEY from the environment (never hard-code it). On the box:
#   set -a; . /opt/clipforge/config/.env; set +a
#
# Usage:
#   FAL_KEY=... ./scripts/gen-video-ad.sh "<image_url|->" "<prompt>" [out.mp4]
#
# Examples:
#   # product ad from a supplier photo
#   ./scripts/gen-video-ad.sh "https://.../product.jpg" \
#     "Fast UGC-style ad: a hand demonstrates the product on a clean desk, punchy quick cuts, bright, energetic, upbeat" ad.mp4
#   # text-only hero
#   ./scripts/gen-video-ad.sh - \
#     "Cinematic vertical: a glowing red-orange titanium ring rotating in dark space, light streaks, premium, moody" hero.mp4

set -euo pipefail

IMG="${1:?image url required (use - for text-only)}"
PROMPT="${2:?prompt required}"
OUT="${3:-ad.mp4}"
: "${FAL_KEY:?set FAL_KEY (export it or source config/.env)}"

# NOTE: keep prompts free of literal double-quotes (this uses simple JSON quoting).
if [ "$IMG" = "-" ] || [ -z "$IMG" ]; then
  MODEL="bytedance/seedance-2.0/fast/text-to-video"
  BODY='{"prompt":"'"$PROMPT"'","aspect_ratio":"9:16","resolution":"720p","generate_audio":true}'
else
  MODEL="bytedance/seedance-2.0/fast/reference-to-video"
  BODY='{"prompt":"'"$PROMPT"'","image_urls":["'"$IMG"'"],"aspect_ratio":"9:16","resolution":"720p","generate_audio":true}'
fi

echo "model: $MODEL"
SUB=$(curl -s -X POST "https://queue.fal.run/$MODEL" \
  -H "Authorization: Key $FAL_KEY" -H "Content-Type: application/json" -d "$BODY")
SU=$(printf '%s' "$SUB" | grep -oP '"status_url"\s*:\s*"\K[^"]+' || true)
RU=$(printf '%s' "$SUB" | grep -oP '"response_url"\s*:\s*"\K[^"]+' || true)
if [ -z "$SU" ]; then echo "SUBMIT FAILED: $SUB"; exit 1; fi

echo "queued. polling..."
for i in $(seq 1 80); do
  ST=$(curl -s "$SU" -H "Authorization: Key $FAL_KEY")
  S=$(printf '%s' "$ST" | grep -oP '"status"\s*:\s*"\K[^"]+' || echo "?")
  echo "  [$i] $S"
  [ "$S" = "COMPLETED" ] && break
  printf '%s' "$ST" | grep -qi '"error"\|"detail"' && { echo "ERR: $ST"; exit 2; }
  sleep 6
done

RES=$(curl -s "$RU" -H "Authorization: Key $FAL_KEY")
VURL=$(printf '%s' "$RES" | grep -oP 'https://[^"]+\.mp4' | head -1 || true)
if [ -z "$VURL" ]; then echo "NO VIDEO URL: $RES"; exit 3; fi

echo "downloading -> $OUT"
curl -s -L "$VURL" -o "$OUT"
ls -la "$OUT"
echo "DONE"
