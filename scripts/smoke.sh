#!/usr/bin/env bash
# T8 smoke journey: health → channel → series → asset intent → (PUT bytes) →
# register → attach → caption → slots → tick → jobs.
#
# Usage:
#   BASE=http://127.0.0.1:8787 MP4_PATH=./ep1.mp4 ./scripts/smoke.sh
#
# Env:
#   BASE      Worker origin (default http://127.0.0.1:8787, i.e. `wrangler dev`).
#   MP4_PATH  Path to a real pre-encoded .mp4 for the byte-upload steps.
#             Needs R2 credentials configured (intent mints a real presigned
#             PUT). When absent/unset, the script prints the manual sequence
#             and runs the read-only steps: slots, tick, jobs.
#   CHAT_ID   Override the throwaway channel chat_id (default @smoke<TIMESTAMP>).
#
# Deps: curl + python3 (stdlib only, no jq). Exits non-zero on the first
# unexpected HTTP code; every response body is printed on failure.
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8787}"
MP4_PATH="${MP4_PATH:-}"
STAMP="$(date +%s)"
CHAT_ID="${CHAT_ID:-@smoke${STAMP}}"
SLUG="smoke-${STAMP}"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
BODY="$TMPDIR/body"

pass() { printf 'PASS %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1" >&2
  printf -- '--- response body ---\n' >&2
  cat "$BODY" >&2 || true
  printf '\n' >&2
  exit 1
}

# api_call <label> <expected-code> <METHOD> <path> [json-body]
api_call() {
  local label="$1" want="$2" method="$3" path="$4"
  local data="${5:-}"
  local code
  if [ -n "$data" ]; then
    code="$(curl -s -o "$BODY" -w "%{http_code}" -X "$method" "$BASE$path" \
      -H 'content-type: application/json' --data "$data")"
  else
    code="$(curl -s -o "$BODY" -w "%{http_code}" -X "$method" "$BASE$path")"
  fi
  if [ "$code" != "$want" ]; then
    printf 'expected HTTP %s, got %s for %s %s\n' "$want" "$code" "$method" "$path" >&2
    fail "$label"
  fi
  pass "$label (HTTP $code)"
}

# jget <python-expr on parsed json> — reads $BODY, prints the value.
jget() {
  python3 -c "import json,sys; print($1)" < "$BODY"
}

printf 'smoke base: %s\n' "$BASE"

# 0. Server reachable?
if ! curl -s -o /dev/null --max-time 5 "$BASE/healthz"; then
  printf 'FAIL worker not reachable at %s (start it: npx wrangler dev --port 8787)\n' "$BASE" >&2
  exit 1
fi

# 1. Health.
api_call "healthz" 200 GET /healthz
printf '  version: %s\n' "$(jget "json.load(sys.stdin)['version']")"

# 2. Channel create (throwaway handle so re-runs never 409).
api_call "channel create" 201 POST /channels \
  "{\"label\":\"smoke ${STAMP}\",\"chat_id\":\"${CHAT_ID}\"}"
CHANNEL_ID="$(jget "json.load(sys.stdin)['id']")"
printf '  channel: %s (%s)\n' "$CHANNEL_ID" "$CHAT_ID"

# 3. Series create, picking that channel.
api_call "series create" 201 POST /series \
  "{\"slug\":\"${SLUG}\",\"title_local\":\"smoke ${STAMP}\",\"total_parts\":3,\"channel_ids\":[\"${CHANNEL_ID}\"]}"
SERIES_ID="$(jget "json.load(sys.stdin)['id']")"
printf '  series: %s\n' "$SERIES_ID"

# 4-8. Byte path — needs R2 credentials (intent mints a real presigned PUT).
# With a file, run it end-to-end; otherwise print the manual sequence and
# skip to the read-only steps (slots/tick/jobs).
ASSET_ID=""
if [ -n "$MP4_PATH" ] && [ -f "$MP4_PATH" ]; then
  # 4. Asset intent (no bytes needed, but needs configured storage).
  SIZE="${MP4_SIZE:-1048576}"
  api_call "asset intent" 200 POST /assets/upload-url \
    "{\"filename\":\"smoke-${STAMP}.mp4\",\"content_type\":\"video/mp4\",\"size_bytes\":${SIZE}}"
  STORAGE_KEY="$(jget "json.load(sys.stdin)['storage_key']")"
  UPLOAD_URL="$(jget "json.load(sys.stdin)['upload_url']")"
  printf '  storage_key: %s\n' "$STORAGE_KEY"
  printf '  upload_url: %s\n' "$UPLOAD_URL"

  # 5. Real byte upload straight to R2 (bytes never pass through the Worker).
  PUT_CODE="$(curl -s -o "$BODY" -w "%{http_code}" -X PUT "$UPLOAD_URL" \
    -H 'content-type: video/mp4' --data-binary "@$MP4_PATH")"
  if [ "$PUT_CODE" != 200 ]; then
    printf 'expected HTTP 200, got %s for PUT upload_url\n' "$PUT_CODE" >&2
    fail "r2 put"
  fi
  pass "r2 put (HTTP 200)"

  # 6. Register (HEAD-verified; 201 first time, 200 on re-register).
  api_call "asset register" 201 POST /assets "{\"storage_key\":\"${STORAGE_KEY}\"}"
  ASSET_ID="$(jget "json.load(sys.stdin)['id']")"
  printf '  asset: %s\n' "$ASSET_ID"

  # 7. Attach as episode 1.
  api_call "part attach" 201 POST "/series/${SERIES_ID}/parts" \
    "{\"asset_id\":\"${ASSET_ID}\",\"part_index\":1,\"hook\":\"smoke hook\"}"
  PART_ID="$(jget "json.load(sys.stdin)['id']")"
  printf '  part: %s\n' "$PART_ID"

  # 8. Episode caption render.
  api_call "part caption" 200 GET "/series/${SERIES_ID}/parts/${PART_ID}/caption"
  python3 -c "import json,sys; d=json.load(sys.stdin); print('  caption_length:', d['caption_length'], '| within_limit:', d['within_limit'])" < "$BODY"
else
  printf 'SKIP byte path: MP4_PATH unset/missing (and intent needs R2 creds).\n'
  printf '  Manual steps with configured storage + a real file:\n'
  printf '    INTENT=$(curl -s -X POST "%s/assets/upload-url" -H "content-type: application/json" --data %s)\n' \
    "$BASE" "'{\"filename\":\"ep1.mp4\",\"size_bytes\":12345}'"
  printf '    curl -X PUT "$(echo "$INTENT" | python3 -c %s)" -H "content-type: video/mp4" --data-binary "@ep1.mp4"\n' \
    "'import json,sys; print(json.load(sys.stdin)[\"upload_url\"])'"
  printf '    curl -X POST "%s/assets" -H "content-type: application/json" --data %s\n' \
    "$BASE" "'{\"storage_key\":\"<storage_key from INTENT>\"}'"
  printf '  Then attach + caption:\n'
  printf '    curl -X POST "%s/series/%s/parts" -H "content-type: application/json" --data %s\n' \
    "$BASE" "$SERIES_ID" "'{\"asset_id\":\"<id>\",\"part_index\":1}'"
fi

# 9. Slots visible (seeded lunch/evening/night from migration 0001).
api_call "slots list" 200 GET /slots
python3 -c "import json,sys; print('  slots:', len(json.load(sys.stdin)))" < "$BODY"

# 10. Tick — always safe (no due slot → zeros summary).
api_call "tick" 200 POST /tick
python3 -c "
import json,sys
d = json.load(sys.stdin)
print('  fired:', d['fired_slots'], '| created:', d['jobs_created'],
      '| published:', d['published'], '| failed:', d['failed'],
      '| deferred:', d['deferred'], '| errors:', d['errors'])
" < "$BODY"

# 11. Jobs list shape.
api_call "jobs list" 200 GET "/jobs?limit=5"
python3 -c "import json,sys; print('  jobs returned:', len(json.load(sys.stdin)))" < "$BODY"

# 12. Tidy up the throwaway fixtures (best-effort; never fails the run).
curl -s -o /dev/null -X DELETE "$BASE/series/$SERIES_ID" || true
curl -s -o /dev/null -X DELETE "$BASE/channels/$CHANNEL_ID" || true
printf 'CLEANUP series + channel deleted (best-effort)\n'

printf 'SMOKE OK\n'
