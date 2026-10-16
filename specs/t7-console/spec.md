# T7 — Console wiring / Pages (spec)

## Why

The API (T1–T6) is operator-complete but operator-hostile: every action is a
curl. T7 adds the Cloudflare Pages console — a zero-build static site that
drives the whole workflow from a browser: upload → channels → series/parts →
captions → slots/jobs → tick.

## Scope

A static site under `console/` deployed with
`npx wrangler pages deploy console`. **No build step, no framework, no
npm dependencies**: `index.html` + `styles.css` + `app.js` (+ `config.js`
holding `API_BASE`, git-ignored with a `config.example.js`). Vanilla JS so
the free tier stays free and the deploy stays one command.

Out of scope: auth (operator console behind Pages Access or obscurity —
document the recommendation, do not implement), video transcoding, any change
to the Worker API (read the T6 spec's endpoints as fixed).

## Views (one page, tabbed)

1. **Assets** — pick `.mp4` → `POST /assets/upload-url` → `PUT` bytes to
   `upload_url` with `Content-Type: video/mp4` → `POST /assets`; show the
   registered asset id + size. Surface 413/415 errors verbatim.
2. **Channels** — table (`GET /channels`), create form, enable/disable +
   `protect_content` toggles (`PATCH`), delete with confirm, per-row
   **Verify** button (`POST …/verify`) showing the resolved chat title or
   the Telegram error.
3. **Series** — list, create (slug + titles + total + templates + hashtags +
   channel pick as checkboxes from `GET /channels`), edit, delete; inside a
   series: parts table in episode order, attach form (asset id + index +
   hook), hook editing, detach, per-part **Caption** preview
   (`GET …/caption`), and the series channel pick editor with stale-id
   warnings from `missing_ids`.
4. **Captions** — free preview lab: same fields as `POST /captions/preview`
   with live render, length meter vs 1024, truncation warning.
5. **Schedule** — slots table (`GET /slots`) with time/enabled editing
   (`PATCH`), jobs table (`GET /jobs`, filter by state, refresh), per-failed
   **Retry** button, **Run tick now** button (`POST /tick`) with the summary
   rendered, and a last-tick result pane.

## Contracts

- All API calls use `fetch` against `API_BASE` with JSON bodies; every
  `{ error: { code, message } }` response is shown to the operator as-is
  (code + message), never swallowed.
- File upload sets the exact `Content-Type: video/mp4` header on the R2 PUT
  (signature requirement from T2).
- `config.js` is the only per-deploy file: `window.APP_CONFIG = { API_BASE:
  "https://telegram-serverless.<account>.workers.dev" }`. The app must fail
  with a visible banner when it is missing, not with a blank page.
- Works from `file://` for local smoke (CORS: Worker serves same-origin in
  prod; document that local file use needs `wrangler dev` + Pages local or
  the temp CORS note in T8 — do not add CORS headers in this slice).

## Acceptance

- [ ] `npx wrangler pages deploy console` succeeds (static only).
- [ ] Every T1–T6 endpoint is reachable from some view; error codes surface.
- [ ] Upload → register → attach → caption → tick → published is clickable
      end-to-end against a dev Worker.
- [ ] No files outside `console/` are touched.
