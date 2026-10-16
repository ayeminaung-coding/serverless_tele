/** telegram-serverless Worker: upload intake + health. T1+T2 slice.
 *
 * Routes implemented here:
 *   GET  /healthz
 *   POST /assets/upload-url   mint a presigned R2 PUT (validated, pre-encoded .mp4 only)
 *   POST /assets              verify the uploaded object (R2 HEAD) and register it
 *
 * Coming in later slices: channels CRUD (T3), sendVideo client (T3), caption
 * render + preview (T4), series (T5), slots/backlog/tick (T6), console wiring (T7).
 */

import { Hono } from "hono";
import { getAssetByStorageKey, insertAsset } from "./db";
import { type R2Credentials, presignedPutUrl } from "./r2";
import {
  ALLOWED_CONTENT_TYPE,
  UploadValidationError,
  assertStoredSizeOk,
  validateUploadIntent,
} from "./validation";

export const VERSION = "0.1.0";

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_PUBLIC_BASE_URL: string;
}

const app = new Hono<{ Bindings: Env }>();

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

app.get("/healthz", (c) => c.json({ status: "ok", version: VERSION }));

app.post("/assets/upload-url", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    filename?: unknown;
    content_type?: unknown;
    size_bytes?: unknown;
  } | null;
  if (!body) {
    return c.json(errorBody("invalid_json", "request body must be JSON"), 400);
  }
  let storageKey: string;
  try {
    storageKey = validateUploadIntent({
      filename: typeof body.filename === "string" ? body.filename : "",
      contentType:
        typeof body.content_type === "string" ? body.content_type : ALLOWED_CONTENT_TYPE,
      sizeBytes: typeof body.size_bytes === "number" ? body.size_bytes : undefined,
    });
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return c.json(errorBody(err.code, err.message), err.status as 400);
    }
    throw err;
  }

  const creds: R2Credentials = {
    accountId: c.env.R2_ACCOUNT_ID,
    bucket: c.env.R2_BUCKET,
    accessKeyId: c.env.R2_ACCESS_KEY_ID,
    secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
  };
  try {
    const { url, expiresSeconds } = await presignedPutUrl(
      creds,
      storageKey,
      ALLOWED_CONTENT_TYPE,
    );
    return c.json({
      storage_key: storageKey,
      upload_url: url,
      expires_seconds: expiresSeconds,
    });
  } catch {
    // Signing is local, so this only fires on misconfigured storage.
    return c.json(
      errorBody("storage_misconfigured", "R2 credentials are missing or invalid"),
      503,
    );
  }
});

app.post("/assets", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { storage_key?: unknown } | null;
  const storageKey = typeof body?.storage_key === "string" ? body.storage_key : "";
  if (!storageKey) {
    return c.json(errorBody("missing_storage_key", "storage_key is required"), 400);
  }

  // Idempotent re-registration: the same key never creates two assets.
  const existing = await getAssetByStorageKey(c.env.DB, storageKey);
  if (existing) {
    return c.json(existing, 200);
  }

  const head = await c.env.MEDIA.head(storageKey);
  if (!head) {
    return c.json(
      errorBody("object_not_found", "no uploaded object at storage_key; PUT it first"),
      404,
    );
  }
  try {
    assertStoredSizeOk(head.size);
  } catch (err) {
    if (err instanceof UploadValidationError) {
      // Drop the oversized object so it does not sit in the bucket unbilled-attention.
      await c.env.MEDIA.delete(storageKey).catch(() => undefined);
      return c.json(errorBody(err.code, err.message), err.status as 400);
    }
    throw err;
  }

  const asset = await insertAsset(c.env.DB, {
    id: crypto.randomUUID(),
    storageKey,
    sizeBytes: head.size,
  });
  return c.json(asset, 201);
});

export default {
  fetch: app.fetch,
  /** Cron heartbeat arrives here every 15 min. Full slot tick lands in T6. */
  async scheduled(): Promise<void> {
    console.log("tick received: schedule release not implemented yet (T6)");
  },
};
