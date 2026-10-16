# T6 — Slots + ordered backlog + tick release (spec)

## Why

T1–T5 built intake, address book, copy engine, and episode order. Nothing
sends anything yet. T6 closes the loop: the 15-minute cron heartbeat (plus a
manual trigger) decides what is due, fans series episodes out into
`publish_jobs`, and delivers each job with one `sendVideo` call.

## Scope

- Slot-due evaluation against `schedule_slots` (at most once per slot per day).
- Ordered backlog: per (series, channel) progress, next episode selection.
- Job lifecycle on `publish_jobs`: `scheduled → published | failed`
  (rate-limited/network errors stay `scheduled` for a later tick).
- Delivery via the T3 `sendVideo` client with per-channel `protect_content`.
- Manual controls: slots CRUD-lite (list + retune), jobs list, job retry,
  manual tick. The `scheduled` cron handler runs the same core as `POST /tick`.

Out of scope: console UI (T7), ffmpeg/transcoding (never — pre-encoded only),
multi-video albums, editing already-sent messages.

## Contracts

### Slot due

A slot is due at time `now` when all hold:

1. `enabled = 1`.
2. `last_fired_on` is NULL or not equal to **today's date in the slot's
   `timezone`** (`YYYY-MM-DD` via `Intl.DateTimeFormat` with `timeZone`).
3. The slot's `hour:minute` is at or before the **current time in the slot's
   `timezone`** (same `Intl` source — never the Worker's UTC clock directly).

After a tick processes a due slot (even with partial failures),
`last_fired_on` is set to that YYYY-MM-DD. At-most-once per slot per day is
the invariant; failures are recovered via job retry, never via re-firing.

### Backlog selection

For each series (ascending `created_at`, then `id`) with a non-empty
`channel_ids` pick, for each picked channel id in order:

1. Resolve the channel; skip silently when missing (`missing_ids` semantics
   from T5) or `enabled = 0`.
2. Progress = highest `part_index` with a `published` job for
   (series part, channel). Next = progress + 1.
3. If a part with that index exists → ensure-then-send (below).
4. If no such part exists → nothing (series fully released on that channel).

Rationale: per-(series, channel) progress keeps channels independent — one
channel's failure or late subscription never shifts another's episode order.

### Job ensure-then-send (idempotent)

1. Look up an existing job by `UNIQUE(asset_id, channel_id)`.
   - `published` → skip (already sent).
   - `scheduled`/`failed` → reuse the row (reset `failed` → `scheduled` only
     via explicit retry; a tick re-attempts `scheduled` rows but never flips
     `failed` on its own).
   - none → insert with `chat_id_snapshot` frozen from the channel,
     `caption` rendered now (T4 engine), `state = 'scheduled'`, `attempts = 0`.
2. Guardrails before sending: `TELEGRAM_BOT_TOKEN` and `R2_PUBLIC_BASE_URL`
   configured, else leave `scheduled` with `last_error` set (no busy-loop,
   no state churn beyond the error note).
3. Send: `sendVideo(token, { chat_id: job.chat_id_snapshot, video:
   <R2_PUBLIC_BASE_URL>/<asset.storage_key>, caption: job.caption,
   protect_content: <channel flag> })`.
4. Outcome mapping:
   - success → `published`, `external_id = message_id`, `attempts + 1`,
     `last_error = NULL`.
   - `telegram_rate_limited` / `telegram_unreachable` → stays `scheduled`,
     `attempts + 1`, `last_error` set (retried by a later tick).
   - `telegram_forbidden` / other `telegram_api_error` → `failed`,
     `attempts + 1`, `last_error` set (operator fixes token/admin rights,
     then `POST /jobs/:id/retry`).

Caption for a job is rendered with the same inputs as
`GET /series/:id/parts/:partId/caption` (total = `series.total_parts` ??
max attached index). If the shared render helper is extracted to
`src/caption.ts` (additive export), the old endpoint must use it too.

### API

| Method | Path | Notes |
|---|---|---|
| GET | `/slots` | list slots ascending time |
| PATCH | `/slots/:id` | `{label?, hour? 0–23, minute? 0–59, timezone?, enabled?}`; timezone validated via `Intl` (`RangeError` → 400); 404 unknown |
| GET | `/jobs` | query `state?`, `series_id?`, `channel_id?`, `limit?` (default 50, max 200); each row joined with asset `storage_key`, series `{id, slug}`, and `part_index` (via `series_parts` by `asset_id`) |
| POST | `/jobs/:id/retry` | `failed` → `scheduled` and dispatch immediately; returns the job; 404 unknown; 409 when state is not `failed` |
| POST | `/tick` | run the full tick now; returns `{ fired_slots: string[], jobs_created: number, published: number, failed: number, deferred: number, errors: string[] }`; safe to call any time (no due slots → zeros) |

`scheduled()` in `src/index.ts` runs the same core with real `fetch`.

## Acceptance

- [ ] Tick with a due slot + one series (1 part) + one channel creates exactly
      one job and publishes it; slot marked fired for that day.
- [ ] Second tick same day changes nothing (zeros summary).
- [ ] Rate-limit (429+`retry_after`) keeps the job `scheduled` with attempts+1.
- [ ] 403 marks the job `failed`; retry re-sends and can publish.
- [ ] Missing token / missing public base URL defers without crashing.
- [ ] Progress is per channel: channel A published part 1 while B failed still
      sends part 1 (not 2) to B next tick.
- [ ] `tsc --noEmit` clean; new `tests/publish.test.ts` green; full suite green.
