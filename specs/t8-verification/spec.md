# T8 — Full test/docs pass + live checklist (spec)

## Why

T6+T7 complete the system; T8 proves it. A green suite, accurate docs, a
repeatable smoke script, and a live checklist the operator follows once with
real credentials — so "it works" is evidence, not belief.

## Scope

Docs, scripts, and test-suite repair only. **No `src/` behavior changes.**
A failing test may be fixed only when the test itself is wrong (state why in
the report); a failing implementation goes back to the owning slice.

## Deliverables

1. **Full pass**: `npm run typecheck` + `npm test` green; fix or file every
   warning; report final counts per test file.
2. **`scripts/smoke.sh`** (executable, `set -euo pipefail`): drives the API
   at `$BASE` through health → channel create → series create → asset
   intent (prints the PUT URL; upload step is manual `curl -X PUT` since
   bytes vary) → register → attach → caption → slots → tick → jobs, asserting
   HTTP codes with `curl -s -o /dev/null -w "%{http_code}"`. Skips Telegram
   delivery assertions (needs secrets) but verifies shapes with `python3 -c`
   or `jq` where present — prefer `python3` stdlib (no new dependency).
3. **`docs/LIVE_CHECKLIST.md`**: ordered one-time runbook — secrets
   (`wrangler secret put` ×3), D1 create + id paste, R2 bucket + public
   domain, `db:migrate`, deploy Worker, deploy Pages, bot-admin steps for one
   public + one private channel, first real upload → tick → message in
   Telegram, what to check when each step fails (maps to API error codes).
4. **`README.md` final**: T6–T8 checked, API section complete (slots/jobs/
   tick endpoints), console + smoke + checklist linked, `plan`-mode style —
   no stale slice notes.

## Acceptance

- [ ] `tsc` + full suite green; per-file counts reported.
- [ ] `scripts/smoke.sh` runs against `wrangler dev` (or documents the one
      manual byte-upload step) with zero unexpected failures.
- [ ] README API covers every route in `src/index.ts` (mechanical cross-check).
- [ ] `docs/LIVE_CHECKLIST.md` is followable by the repo owner cold.
- [ ] No `src/` diffs except zero (verify with `git status`/`git diff`).
