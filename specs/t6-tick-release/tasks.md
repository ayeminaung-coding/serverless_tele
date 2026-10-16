# T6 — Tasks

- [ ] `src/publish.ts`: `PublishJob`/`Slot` types, slot validation
      (`SlotValidationError` with `code`/`status`), `zonedParts`,
      `isSlotDue(slot, nowMs)`.
- [ ] `src/publish.ts`: job helpers (`getJobById`, `findJob`, `insertJob`,
      `markJob`, job list query with `state` filter + limit clamp).
- [ ] `src/publish.ts`: `runTick(env, { nowMs, fetchImpl })` — due slots →
      per-series/per-channel progress → ensure-then-send → fire-marking →
      summary. Uses `sendVideo`/`TelegramApiError` from `src/telegram.ts`,
      `renderEpisode`/`normaliseHashtags` from `src/caption.ts`, existing
      series/channel/asset/part helpers. No new SQL for those tables.
- [ ] `src/index.ts`: `GET /slots`, `PATCH /slots/:id`, `GET /jobs`,
      `POST /jobs/:id/retry`, `POST /tick` with `errorBody` mapping
      (validation 400, unknown id 404, retry on non-failed 409).
- [ ] `src/index.ts`: `scheduled()` runs `runTick` with real `fetch`.
- [ ] (optional, additive-only) `src/caption.ts`: shared `renderPartCaption`
      + switch the T5 caption endpoint onto it.
- [ ] `tests/publish.test.ts`: slot-due incl. timezone/day-fence edges;
      tick publishes one job and marks the slot; same-day re-tick is a no-op;
      429 defers `scheduled`; 403 fails; retry republishes; missing
      token/base-URL defers; per-channel progress independence.
- [ ] `npm run typecheck` clean + full `npm test` green.
