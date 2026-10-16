# T7 — Plan

## Files (all new, all under `console/`)

- `console/index.html` — tab shell + five view sections + banner slot.
- `console/styles.css` — compact dark-capable stylesheet, no assets.
- `console/app.js` — vanilla JS: `api()` helper (JSON + error surfacing),
  per-view render + forms, upload flow (intent → PUT → register), tick +
  retry actions.
- `console/config.example.js` — `window.APP_CONFIG = { API_BASE: "…" }`.
- `console/README.md` — deploy + local-use instructions.

`.gitignore` already ignores nothing named config — keep the real
`console/config.js` untracked by **not creating it** (only the example);
the app must handle its absence with a banner.

## Sequencing

1. Shell + `api()` helper + Channels view (simplest CRUD loop to validate
   the pattern).
2. Assets upload flow (the only non-JSON flow — get it right early).
3. Series + parts + caption preview; Captions lab (shares the render pane).
4. Schedule (slots/jobs/tick/retry).
5. `console/README.md`; deploy dry-check (`wrangler pages deploy` needs
   account — at minimum validate the directory is static-safe: no imports,
   no build references).
6. Check off `tasks.md`; report files + manual click-through results.
