# T6 — Plan

## Files

- `src/publish.ts` (**new**, sole owner): slot helpers, job helpers, tick core.
  Pure logic takes injected `now` (ms epoch) and `fetchImpl` so tests never
  touch the network or wall clock.
- `src/index.ts` (**append-only** + `scheduled` handler): five routes, error
  mapping via existing `errorBody`. May replace the inline caption render in
  `GET /series/:id/parts/:partId/caption` with the shared helper if one is
  extracted — no other refactors.
- `src/caption.ts` (**additive-only**): optional `renderPartCaption(series,
  part, total?)` export reused by both the T5 endpoint and the tick. No
  signature changes to existing exports.
- `tests/publish.test.ts` (**new**): unit (slot-due incl. timezone edge,
  progress selection) + route (`/tick`, `/jobs`, `/jobs/:id/retry`,
  `/slots`) with an in-memory D1 stub + stubbed Telegram `fetch`.

## Queries (D1, raw prepared statements)

Slots: `SELECT … FROM schedule_slots ORDER BY hour ASC, minute ASC, id ASC`;
`SELECT … WHERE id = ?`; dynamic `UPDATE schedule_slots SET … WHERE id = ?`;
fire-mark `UPDATE schedule_slots SET last_fired_on = ? WHERE id = ?`.
Validate `hour`/`minute` ranges and `timezone` with
`new Intl.DateTimeFormat("en-CA", { timeZone })` in try/catch.

Jobs: `INSERT INTO publish_jobs (id, asset_id, channel_id, chat_id_snapshot,
caption, state) VALUES (?,?,?,?,?,'scheduled') RETURNING …`;
`SELECT … WHERE id = ?`; `SELECT … WHERE asset_id = ? AND channel_id = ?`
(prefer explicit lookup; the UNIQUE is the backstop, mapped to reuse);
list with optional `state = ?` filter + `LIMIT ?`, enriched in code via
`getAssetById`, `getSeriesById`-style lookups and
`getPartByAssetId` (already in `src/series.ts`, `src/db.ts` — reuse, do not
reimplement); `UPDATE publish_jobs SET state = ?, attempts = ?, last_error =
?, external_id = ?, updated_at = ? WHERE id = ?` (keep `updated_at` fresh via
`strftime('%Y-%m-%dT%H:%M:%fZ','now')` in SQL or ISO string in code).

Progress: per series, `SELECT sp.part_index FROM series_parts … JOIN
publish_jobs … WHERE state='published'` — simplest correct shape:
`SELECT part_index FROM series_parts WHERE series_id = ?` (ordered) plus
`SELECT asset_id FROM publish_jobs WHERE channel_id = ? AND state =
'published'` mapped back through parts by `asset_id`. All single-table
reads; join in code to stay stub-friendly.

Series/channel/asset/part reads reuse `src/series.ts`, `src/channels.ts`,
`src/db.ts` helpers — no new SQL for those tables.

## Time handling

```ts
function zonedParts(ms: number, timeZone: string): { date: string; hour: number; minute: number }
```

via `Intl.DateTimeFormat("en-CA", { timeZone, year, month, day, hour,
minute, hour12: false })`. One helper, used for both the date fence and the
time fence so they can never disagree.

## Sequencing

1. `src/publish.ts`: slot types + validation + `slotsDue` + `zonedParts`.
2. Job helpers + `runTick(env, { nowMs, fetchImpl })` core returning the
   summary shape from the spec.
3. Routes + `scheduled()` wiring.
4. `tests/publish.test.ts` (write alongside, not after).
5. `npm run typecheck`, `npx vitest run tests/publish.test.ts`, full suite.
6. Check off `tasks.md`; report back files changed + test counts.
