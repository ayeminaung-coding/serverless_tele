# T8 — Plan

## Files

- `scripts/smoke.sh` (**new**, executable): BASE-configurable curl journey.
- `docs/LIVE_CHECKLIST.md` (**new**): cold-start runbook.
- `README.md` (**edit**): status boxes T6–T8, full API table, links.
- `tests/` (**fix-only-if-wrong**, each fix explained in the final report).

## Sequencing (only after T6 + T7 agents report done)

1. `git status` — confirm clean except T6/T7 output; read the final
   `src/index.ts` route list as the source of truth for docs.
2. `npm run typecheck` + `npm test`; record per-file counts.
3. Write `scripts/smoke.sh`; run against `npm run dev` if a dev server can
   start headless (background + `trap kill`), else mark live-only steps.
4. Write `docs/LIVE_CHECKLIST.md` from the real config surface
   (`wrangler.toml`, `.dev.vars.example`, migration file).
5. Update `README.md`; re-run suite; report.
