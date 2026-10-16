# telegram-serverless

Serverless Telegram channel video publisher: pre-encoded MP4 + caption in,
scheduled or immediate posts out to public and private channels. Runs entirely
on Cloudflare's free tier — Workers + D1 + R2 + Cron Triggers + Pages.

This is the sibling of `sau-media` (the Python fan-out pipeline for TikTok and
Facebook). That stack stays as-is; this repo covers the Telegram-only path,
where the constraints fit serverless: one fast `sendVideo` POST per channel,
no chunked resumable uploads, no ffmpeg.

## Why this shape

- Workers free = 10ms CPU / 128MB: **no ffmpeg**. Uploads must arrive
  pre-encoded (H.264/AAC `.mp4`, ≤50 MB cloud Bot API cap). The server
  validates the contract instead of transcoding.
- Video bytes never pass through the Worker: the browser PUTs straight to R2
  with a presigned URL; Telegram fetches via the public R2 URL.
- The Cron trigger replaces n8n's slot-tick; D1 replaces Postgres; direct
  `sendVideo` calls replace Redis/RQ (each post is one fast request).

## Status

- [x] T1 — wrangler config, D1 schema, channel/job/series/slot tables
- [x] T2 — presigned upload + 50 MB guard + asset registration
- [ ] T3 — Telegram `sendVideo` client + channels CRUD
- [ ] T4 — caption render (template + hook, 1024 cap) + preview
- [ ] T5 — series CRUD + parts + per-series channel pick
- [ ] T6 — slots + ordered backlog + tick release
- [ ] T7 — console wiring (Pages build against this API)
- [ ] T8 — full test/docs pass + live verification checklist

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in R2 keys + bot token

npx wrangler d1 create telegram-serverless   # paste database_id into wrangler.toml
npx wrangler r2 bucket create telegram-serverless-media
# attach a public custom domain to the bucket -> R2_PUBLIC_BASE_URL

npm run db:migrate
npm run dev
```

Secrets for deploys:

```bash
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN   # used from T3 on
```

## API (T1+T2)

- `GET /healthz` → `{status, version}`
- `POST /assets/upload-url` `{filename, content_type?, size_bytes?}` →
  `{storage_key, upload_url, expires_seconds}` (rejects non-`.mp4`, wrong
  content type, declared size >50 MB)
- `POST /assets` `{storage_key}` → `201` asset (verifies via R2 HEAD;
  oversized objects are deleted and rejected with 413)

## Verify this slice

```bash
npm run typecheck
npm test
```
