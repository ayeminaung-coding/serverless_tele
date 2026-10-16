# Specs — telegram-serverless (SDD)

Spec-Driven Development: **spec → plan → tasks → implement → verify**.
No production code lands without a spec in this directory, and no task is
marked done without `npm run typecheck` + `npm test` green.

## Slice map

| Slice | Spec | Status | Implemented in |
|---|---|---|---|
| T1 wrangler config + D1 schema | — (bootstrapped pre-SDD) | done | `wrangler.toml`, `migrations/0001_init.sql` |
| T2 presigned upload + 50 MB guard + asset registration | — (bootstrapped pre-SDD) | done | `src/index.ts`, `src/validation.ts`, `src/r2.ts`, `src/db.ts` |
| T3 `sendVideo` client + channels CRUD | — (bootstrapped pre-SDD) | done | `src/telegram.ts`, `src/channels.ts` |
| T4 caption engine + preview | — (bootstrapped pre-SDD, ported from sau-media `captions/template.py`) | done | `src/caption.ts` |
| T5 series CRUD + parts + channel pick | — (bootstrapped pre-SDD) | done | `src/series.ts` |
| T6 slots + ordered backlog + tick release | [`t6-tick-release/`](t6-tick-release/) | **in progress** | `src/publish.ts`, `src/index.ts`, `tests/publish.test.ts` |
| T7 console wiring (Pages) | [`t7-console/`](t7-console/) | **in progress** | `console/` only |
| T8 full test/docs pass + live checklist | [`t8-verification/`](t8-verification/) | pending T6+T7 | `docs/`, `scripts/`, `README.md` |

## Conventions (binding on all implementers)

- Runtime: Cloudflare Workers + Hono. Raw D1 prepared statements, no ORM.
  Dates ISO-8601 TEXT, booleans INTEGER 0/1, ids `crypto.randomUUID()`.
- API errors: `{ error: { code, message } }` via the `errorBody` helper in
  `src/index.ts`. Validation errors carry `code` + `status` (400/409/413/429…).
- Telegram transport lives in `src/telegram.ts` — never reimplement
  `ok:false` unwrapping or 429/401/403 mapping elsewhere.
- Caption rendering lives in `src/caption.ts` — never rebuild templates
  elsewhere; reuse `renderEpisode` + `normaliseHashtags`.
- Tests use `vitest` with in-memory D1 stubs shaped exactly like the SQL the
  helpers emit (see `tests/channels.test.ts`, `tests/series.test.ts`).
  Route tests go through `app.request(path, init, env)` with stub bindings.
- File ownership during orchestrated implementation (no cross-edits):
  - T6 agent: `src/publish.ts` (new), `tests/publish.test.ts` (new),
    `src/index.ts` (append routes + `scheduled` only), additive-only export in
    `src/caption.ts` if a shared render helper is needed.
  - T7 agent: `console/` only. Must not touch `src/`, `tests/`,
    `migrations/`, `wrangler.toml`, root `README.md`.
  - T8 agent: `docs/`, `scripts/`, root `README.md`; `tests/` fixes only to
    repair a wrong test (must explain), never `src/` behavior changes.

## Reading a slice spec

Each slice directory holds `spec.md` (what + why + contracts + acceptance),
`plan.md` (how: files, queries, sequencing), `tasks.md` (ordered checklist).
Implementers work top-down and check off `tasks.md` as they land each item.
