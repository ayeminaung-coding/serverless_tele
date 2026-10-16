# LIVE_CHECKLIST — one-time production runbook

Do this once, in order, with real credentials. Every step names its failure
mode and the API error code it maps to, so a red response tells you exactly
what to fix. Assumes T1–T8 committed on `main`, `npm run typecheck` and
`npm test` green locally.

> Fixed post-T8: `wrangler dev` failed to boot with `Incorrect type for map
> entry 'VERSION'` (workerd rejects non-handler exports). `VERSION` in
> `src/index.ts` is now module-local; `npm test` was always unaffected
> (vitest imports `app`, not the worker entrypoint).

Prerequisites: Node 20+, `npm install` done, a Cloudflare account, a Telegram
bot token from [@BotFather](https://t.me/BotFather).

## 0. Local gate

```bash
npm run typecheck
npm test            # expect 82 passed across 7 files
```

## 1. Secrets (3)

Production secrets live in the Worker, never in `wrangler.toml`:

```bash
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

Local dev mirror: `cp .dev.vars.example .dev.vars` and fill the same three
values (`.dev.vars` is never committed). Missing token → `bot_token_missing`
(503) on verify/tick; missing R2 keys → `storage_misconfigured` (503) on
`POST /assets/upload-url`.

## 2. D1 database

```bash
npx wrangler d1 create telegram-serverless
```

Paste the returned `database_id` into `wrangler.toml` (replacing
`REPLACE_AFTER_WRANGLER_D1_CREATE`), then apply the schema:

```bash
npm run db:migrate
```

Verify: `npx wrangler d1 execute telegram-serverless --remote
--command "SELECT id FROM schedule_slots;"` → three rows (`slot-lunch`,
`slot-evening`, `slot-night`; seeded by `migrations/0001_init.sql` plus the
`0002` repair — 0001's guard seeded lunch only on databases that ran it
first).

Local dev needs the same schema in the local D1 before `wrangler dev`
(otherwise every DB route 500s with `no such table`):

```bash
npx wrangler d1 migrations apply telegram-serverless --local
```

## 3. R2 bucket + public domain

```bash
npx wrangler r2 bucket create telegram-serverless-media
```

Attach a public custom domain to the bucket (dashboard: R2 → bucket →
Settings → Custom Domains), then set in `wrangler.toml`:

```toml
R2_PUBLIC_BASE_URL = "https://media.example.com"
R2_ACCOUNT_ID = "<account id>"
```

Telegram fetches video bytes from this domain, so this step gates delivery:
without it, ticks `defer` jobs instead of publishing (see §9).

## 4. Deploy the Worker

```bash
npx wrangler deploy
```

Record the URL: `https://telegram-serverless.<account>.workers.dev`.
Smoke it (needs a real `.mp4` for the upload leg; without one the script
prints the manual PUT and skips register/attach/caption):

```bash
BASE=https://telegram-serverless.<account>.workers.dev \
MP4_PATH=./ep1.mp4 ./scripts/smoke.sh
```

Without `MP4_PATH` the script still exercises health → channel → series →
intent → slots → tick → jobs, then deletes its throwaway fixtures.

## 5. Deploy the console (Pages)

```bash
cp console/config.example.js console/config.js
# edit console/config.js:
#   window.APP_CONFIG = { API_BASE: "https://telegram-serverless.<account>.workers.dev" }
npx wrangler pages deploy console
```

(`config.js` holds your Worker URL and must never be committed.)
Recommended: put the Pages URL behind Cloudflare Access — the console has no
auth by design (see `console/README.md`).

## 6. Bot-admin steps (Telegram clients)

1. Create/open the bot chat, note the bot username.
2. **Public channel**: create channel → administrators → add the bot as admin
   (Post Messages permission). `chat_id` is `@handle`.
3. **Private channel**: create channel → add the bot as admin (Post Messages;
   it must be a member to see anything). `chat_id` is the numeric `-100…` id
   (visible in clients once the channel has a message link, or via
   `@getmyid`-style bots).

## 7. Register the two channels

In the console (Channels view) or via API:

```bash
curl -X POST "$BASE/channels" -H 'content-type: application/json' \
  --data '{"label":"public","chat_id":"@yourhandle","is_public":true}'
curl -X POST "$BASE/channels" -H 'content-type: application/json' \
  --data '{"label":"private","chat_id":"-1001234567890","is_public":false}'
```

Then prove the bot can see each one (fails fast before any bytes move):

```bash
curl -X POST "$BASE/channels/<id>/verify"
```

→ `{ok:true, channel, chat}` on success. `telegram_forbidden` (403) means the
bot is not admin / not a member — fix in the Telegram client and re-verify.
`bot_token_missing` (503) means §1 is incomplete.

## 8. First real release (end-to-end proof)

1. Assets view (or `scripts/smoke.sh` with `MP4_PATH`): pick a pre-encoded
   `.mp4` (H.264/AAC, ≤50 MB) → Upload + register → note the asset id.
2. Series: create a series with `total_parts`, pick both channels → Open →
   attach the asset at `part_index` 1 with a hook.
3. Series detail → Caption preview: confirm `within_limit: true`.
4. Schedule view → **Run tick now** (or `curl -X POST "$BASE/tick"`).
5. Check both Telegram channels: the video arrives with the rendered caption.
6. Jobs view: the job reads `published` with an `external_id`.

To force a scheduled release instead: set a slot a few minutes ahead
(`PATCH /slots/<id>` `{"hour":H,"minute":M}` in `Asia/Bangkok`), wait for the
15-minute Cron heartbeat (`*/15 * * * *` in `wrangler.toml`), re-check jobs.
Re-tick the same day is a no-op (at-most-once per slot per day).

## 9. When a step fails — error code map

All errors are `{ error: { code, message } }`. HTTP status in parentheses.

| Code | (Status) | Means | Fix |
|---|---|---|---|
| `missing_filename` | 400 | intent without filename | send `filename` ending `.mp4` |
| `unsupported_container` | 415 | not an `.mp4` | pre-encode to H.264/AAC `.mp4`; no ffmpeg on Workers |
| `unsupported_content_type` | 415 | `content_type` ≠ `video/mp4` | send `video/mp4` exactly |
| `invalid_size` / `invalid_stored_size` | 400 | bad/empty size | real file, non-empty |
| `video_too_large` | 413 | >50 MB declared or stored (stored object is deleted) | re-encode smaller; Bot API cap is hard |
| `storage_misconfigured` | 503 | R2 keys missing | §1 + `R2_ACCOUNT_ID`/`R2_BUCKET` in `wrangler.toml` |
| `missing_storage_key` | 400 | register without key | PUT first, then `POST /assets` with its `storage_key` |
| `object_not_found` | 404 | nothing at `storage_key` | complete the R2 PUT before registering |
| `chat_id_taken` | 409 | channel exists | reuse it (`GET /channels`) |
| `channel_not_found` | 404/400 | bad channel id (incl. series `channel_ids`) | list channels, fix the id |
| `bot_token_missing` | 503 | no bot token | §1 |
| `telegram_forbidden` | 403 | bot can't see the chat | §6 admin steps, then re-verify |
| `telegram_rate_limited` | 429 | Telegram 429 (`retry_after_seconds` included) | wait; tick defers and retry resumes |
| `telegram_api_error` / `telegram_bad_response` | 502 | Telegram-side failure | retry; job stays `scheduled` (retryable) or `failed` |
| `slug_taken` | 409 | series slug clash | pick another slug (kebab-case) |
| `missing_slug` | 400 | series without slug | `slug` is required |
| `total_below_parts` | 400 | shrinking `total_parts` below attached parts | detach parts first or keep the total |
| `asset_not_found` | 404 | attach/… references unknown asset | register the asset first |
| `part_beyond_total` | 400 | `part_index` exceeds series total | raise `total_parts` or fix the index |
| `part_index_taken` | 409 | episode already attached | use the next free index |
| `asset_already_attached` | 409 | one asset = one part | one attachment per asset, ever |
| `part_not_found` | 404 | bad part id / wrong series | check `GET /series/:id/parts` |
| `invalid_total` | 400 | caption preview with bad total | `total_parts` must be a positive integer |
| `empty_patch` | 400 | PATCH with no fields | send at least one updatable field |
| `slot_not_found` | 404 | bad slot id | `GET /slots` for the seeded ids |
| `invalid_hour` / `invalid_minute` / `invalid_timezone` | 400 | bad slot retune | hour 0–23, minute 0–59, valid IANA timezone |
| `invalid_state` / `invalid_limit` | 400 | bad `/jobs` query | state ∈ scheduled/published/failed; limit ≥ 1 |
| `job_not_found` | 404 | bad job id | `GET /jobs` for ids |
| `job_not_failed` | 409 | retry on non-failed job | only `failed` jobs retry; `scheduled` resume on next tick |

Tick-level: a `deferred` job (missing token or public URL) is not an error —
fix config and tick again. A `failed` job (forbidden/API error) needs
`POST /jobs/:id/retry` after the underlying cause is fixed. One channel's
failure never blocks its siblings.
