# Console (Cloudflare Pages, static)

Zero-build operator console for the telegram-serverless Worker API (T1–T6).
Vanilla HTML + CSS + JS — no framework, no npm dependencies, no build step.

## Files

- `index.html` — tab shell with five views (Assets, Channels, Series, Captions, Schedule) + banner slot.
- `styles.css` — compact stylesheet, dark-mode capable, no assets.
- `app.js` — plain `<script>` (no imports/exports): `api()` helper, per-view render + forms, upload flow, tick + retry.
- `config.example.js` — copy to `config.js` and set `API_BASE`. `config.js` is the only
  per-deploy file and must never be committed (it holds your Worker URL).

## Configure

```bash
cp console/config.example.js console/config.js
# edit console/config.js:
#   window.APP_CONFIG = { API_BASE: "https://telegram-serverless.<account>.workers.dev" }
```

If `config.js` is missing, the console shows a banner instead of a blank page
and API calls are blocked with `missing_config`.

## Deploy (Pages)

```bash
npx wrangler pages deploy console
```

Static only — if this command asks for a build step, something is wrong;
the directory must stay plain static files.

## Local use

The console also works from `file://` for smoke testing, but browsers block
cross-origin `fetch` from `file://`, and the Worker serves same-origin in
production. For local use, either:

- `npx wrangler dev` (Worker) + a local static server for `console/`, or
- `npx wrangler pages dev console` (Pages local), or
- see the temp CORS note in the T8 verification slice.

## Access control (recommended, not implemented)

This console has **no auth** by design (T7 scope). Put it behind
Cloudflare Access (Pages → Access policy) or keep the Pages URL obscure.
Do not expose the console URL publicly without Access.

## Click-through (end-to-end)

1. Assets: pick an `.mp4` → Upload + register → note the asset id + size.
2. Channels: create a channel (`@handle` or `-100…`), then Verify (shows the
   resolved chat title or the Telegram error verbatim).
3. Series: create a series (slug + titles + total + templates + hashtags +
   channel checkboxes) → Open → attach the asset (asset id + index + hook).
4. Series detail → per-part Caption preview; Captions lab for free previews
   (length meter vs 1024, truncation warning).
5. Schedule: edit slots (time/enabled) → Refresh jobs (filter by state) →
   Retry any failed job → Run tick now → summary pane
   (`fired_slots, jobs_created, published, failed, deferred, errors`) plus the last-tick pane.

Every `{ error: { code, message } }` response (413/415/409/…) surfaces verbatim
as `HTTP <status> <code>: <message>` — nothing is swallowed.
