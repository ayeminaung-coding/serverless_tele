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

The Worker answers CORS on every route, so run both sides locally:

```bash
npx wrangler dev --port 8787 &          # API on http://127.0.0.1:8787
cp console/config.example.js console/config.js
# set API_BASE to "http://127.0.0.1:8787" in console/config.js
cd console && python3 -m http.server 8000   # console on http://localhost:8000
```

(`config.js` is git-ignored — never commit it.) One caveat: `POST /assets/upload-url` needs R2 credentials, so the
Assets upload flow 503s locally until `.dev.vars` holds real R2 keys
(`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`); everything else works offline.

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
