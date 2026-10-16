/** telegram-serverless Worker: upload intake + channels + captions + series. T1–T5 slice.
 *
 * Routes implemented here:
 *   GET  /healthz
 *   POST /assets/upload-url   mint a presigned R2 PUT (validated, pre-encoded .mp4 only)
 *   POST /assets              verify the uploaded object (R2 HEAD) and register it
 *   GET  /channels            list channels (created_at order)
 *   POST /channels            create a channel (chat_id unique → 409)
 *   GET  /channels/:id        fetch one channel
 *   PATCH /channels/:id       partial update (chat_id unique → 409)
 *   DELETE /channels/:id      remove (publish_jobs.channel_id SET NULLs)
 *   POST /channels/:id/verify call getChat to prove the bot sees the chat
 *   POST /captions/preview    render caption + title line without any DB writes
 *   GET  /series              list series (created_at order)
 *   POST /series              create a series (slug unique → 409)
 *   GET  /series/:id          fetch one series
 *   PATCH /series/:id         partial update (slug unique → 409)
 *   DELETE /series/:id        remove (parts cascade)
 *   GET  /series/:id/channels resolve the per-series channel pick
 *   GET  /series/:id/parts    list parts in episode order
 *   POST /series/:id/parts    attach an asset as an episode (index/asset unique → 409)
 *   GET|PATCH|DELETE /series/:id/parts/:partId  part detail / edit / detach
 *   GET  /series/:id/parts/:partId/caption  render this episode's caption
 *
 * Coming in later slices: slots/backlog/tick (T6), console wiring (T7).
 */

import { Hono } from "hono";
import {
  CaptionValidationError,
  normaliseHashtags,
  renderEpisode,
} from "./caption";
import {
  ChannelValidationError,
  deleteChannel,
  getChannelById,
  insertChannel,
  isChatIdConflict,
  listChannels,
  updateChannel,
  validateChannelCreate,
  validateChannelPatch,
} from "./channels";
import { getAssetById, getAssetByStorageKey, insertAsset } from "./db";
import { type R2Credentials, presignedPutUrl } from "./r2";
import {
  SeriesValidationError,
  assertChannelsExist,
  deletePart,
  deleteSeries,
  getPartByAssetId,
  getPartById,
  getPartBySeriesAndIndex,
  getSeriesById,
  insertPart,
  insertSeries,
  isPartConflict,
  isSlugConflict,
  listParts,
  listSeries,
  seriesPartStats,
  type SeriesPart,
  updatePart,
  updateSeries,
  validatePartCreate,
  validatePartPatch,
  validateSeriesCreate,
  validateSeriesPatch,
} from "./series";
import { TelegramApiError, getChat } from "./telegram";
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
  TELEGRAM_BOT_TOKEN?: string;
}

const app = new Hono<{ Bindings: Env }>();

/** Exported for route-level tests (app.request with a stub D1). */
export { app };

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

app.get("/channels", async (c) => {
  return c.json(await listChannels(c.env.DB));
});

app.post("/channels", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return c.json(errorBody("invalid_json", "request body must be JSON"), 400);
  }
  let validated;
  try {
    validated = validateChannelCreate({
      label: body["label"],
      chat_id: body["chat_id"],
      is_public: body["is_public"],
      protect_content: body["protect_content"],
      enabled: body["enabled"],
    });
  } catch (err) {
    if (err instanceof ChannelValidationError) {
      return c.json(errorBody(err.code, err.message), err.status as 400);
    }
    throw err;
  }
  try {
    const channel = await insertChannel(c.env.DB, { id: crypto.randomUUID(), ...validated });
    return c.json(channel, 201);
  } catch (err) {
    if (isChatIdConflict(err)) {
      return c.json(errorBody("chat_id_taken", "a channel with this chat_id already exists"), 409);
    }
    throw err;
  }
});

app.get("/channels/:id", async (c) => {
  const channel = await getChannelById(c.env.DB, c.req.param("id"));
  if (!channel) {
    return c.json(errorBody("channel_not_found", "no channel with this id"), 404);
  }
  return c.json(channel);
});

app.patch("/channels/:id", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return c.json(errorBody("invalid_json", "request body must be JSON"), 400);
  }
  let validated;
  try {
    validated = validateChannelPatch({
      label: body["label"],
      chat_id: body["chat_id"],
      is_public: body["is_public"],
      protect_content: body["protect_content"],
      enabled: body["enabled"],
    });
  } catch (err) {
    if (err instanceof ChannelValidationError) {
      return c.json(errorBody(err.code, err.message), err.status as 400);
    }
    throw err;
  }
  try {
    const channel = await updateChannel(c.env.DB, c.req.param("id"), validated);
    if (!channel) {
      return c.json(errorBody("channel_not_found", "no channel with this id"), 404);
    }
    return c.json(channel);
  } catch (err) {
    if (isChatIdConflict(err)) {
      return c.json(errorBody("chat_id_taken", "a channel with this chat_id already exists"), 409);
    }
    throw err;
  }
});

app.delete("/channels/:id", async (c) => {
  const deleted = await deleteChannel(c.env.DB, c.req.param("id"));
  if (!deleted) {
    return c.json(errorBody("channel_not_found", "no channel with this id"), 404);
  }
  return c.body(null, 204);
});

app.post("/channels/:id/verify", async (c) => {
  const channel = await getChannelById(c.env.DB, c.req.param("id"));
  if (!channel) {
    return c.json(errorBody("channel_not_found", "no channel with this id"), 404);
  }
  const token = c.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!token) {
    return c.json(
      errorBody("bot_token_missing", "TELEGRAM_BOT_TOKEN is not configured"),
      503,
    );
  }
  try {
    const chat = await getChat(token, channel.chat_id);
    return c.json({ ok: true, channel, chat });
  } catch (err) {
    if (err instanceof TelegramApiError) {
      const status =
        err.code === "telegram_rate_limited" ? 429 : err.code === "telegram_forbidden" ? 403 : 502;
      const body: Record<string, unknown> = {
        error: { code: err.code, message: err.message },
      };
      if (err.retryAfterSeconds !== undefined) {
        body["retry_after_seconds"] = err.retryAfterSeconds;
      }
      return c.json(body, status as 400);
    }
    throw err;
  }
});

app.post("/captions/preview", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return c.json(errorBody("invalid_json", "request body must be JSON"), 400);
  }
  const partIndex = typeof body["part_index"] === "number" ? body["part_index"] : Number.NaN;
  const total =
    typeof body["total_parts"] === "number"
      ? body["total_parts"]
      : typeof body["total"] === "number"
        ? body["total"]
        : Number.NaN;
  const hook = typeof body["hook"] === "string" ? body["hook"] : "";
  const str = (key: string): string | undefined =>
    typeof body[key] === "string" ? (body[key] as string) : undefined;
  try {
    const rendered = renderEpisode(
      {
        title_local: str("title_local"),
        title_en: str("title_en"),
        synopsis: str("synopsis"),
        language: str("language"),
        style_example: str("style_example"),
        caption_template: str("caption_template"),
        title_template: str("title_template"),
        next_teaser_template: str("next_teaser_template"),
        hashtags: normaliseHashtags(body["hashtags"]),
      },
      { part_index: partIndex, total, hook },
    );
    return c.json({ ...rendered, within_limit: rendered.caption_length <= 1024 });
  } catch (err) {
    if (err instanceof CaptionValidationError) {
      return c.json(errorBody(err.code, err.message), err.status as 400);
    }
    throw err;
  }
});

function seriesError(err: unknown): { code: string; message: string; status: number } | null {
  if (err instanceof SeriesValidationError) {
    return { code: err.code, message: err.message, status: err.status };
  }
  return null;
}

app.get("/series", async (c) => {
  return c.json(await listSeries(c.env.DB));
});

app.post("/series", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return c.json(errorBody("invalid_json", "request body must be JSON"), 400);
  }
  let validated;
  try {
    validated = validateSeriesCreate(body);
    await assertChannelsExist(c.env.DB, validated.channelIds);
  } catch (err) {
    const mapped = seriesError(err);
    if (mapped) return c.json(errorBody(mapped.code, mapped.message), mapped.status as 400);
    throw err;
  }
  try {
    const series = await insertSeries(c.env.DB, { id: crypto.randomUUID(), ...validated });
    return c.json(series, 201);
  } catch (err) {
    if (isSlugConflict(err)) {
      return c.json(errorBody("slug_taken", "a series with this slug already exists"), 409);
    }
    throw err;
  }
});

app.get("/series/:id", async (c) => {
  const series = await getSeriesById(c.env.DB, c.req.param("id"));
  if (!series) {
    return c.json(errorBody("series_not_found", "no series with this id"), 404);
  }
  return c.json(series);
});

app.patch("/series/:id", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return c.json(errorBody("invalid_json", "request body must be JSON"), 400);
  }
  let validated;
  try {
    validated = validateSeriesPatch(body);
    if (validated.channelIds !== undefined) {
      await assertChannelsExist(c.env.DB, validated.channelIds);
    }
    if (validated.totalParts !== undefined && validated.totalParts !== null) {
      const stats = await seriesPartStats(c.env.DB, c.req.param("id"));
      if (stats.maxIndex !== null && validated.totalParts < stats.maxIndex) {
        return c.json(
          errorBody(
            "total_below_parts",
            `total_parts ${validated.totalParts} is below the highest attached part (${stats.maxIndex})`,
          ),
          400,
        );
      }
    }
  } catch (err) {
    const mapped = seriesError(err);
    if (mapped) return c.json(errorBody(mapped.code, mapped.message), mapped.status as 400);
    throw err;
  }
  try {
    const series = await updateSeries(c.env.DB, c.req.param("id"), validated);
    if (!series) {
      return c.json(errorBody("series_not_found", "no series with this id"), 404);
    }
    return c.json(series);
  } catch (err) {
    if (isSlugConflict(err)) {
      return c.json(errorBody("slug_taken", "a series with this slug already exists"), 409);
    }
    throw err;
  }
});

app.delete("/series/:id", async (c) => {
  const deleted = await deleteSeries(c.env.DB, c.req.param("id"));
  if (!deleted) {
    return c.json(errorBody("series_not_found", "no series with this id"), 404);
  }
  return c.body(null, 204);
});

app.get("/series/:id/channels", async (c) => {
  const series = await getSeriesById(c.env.DB, c.req.param("id"));
  if (!series) {
    return c.json(errorBody("series_not_found", "no series with this id"), 404);
  }
  const channels = [];
  const missingIds = [];
  for (const channelId of series.channel_ids) {
    const channel = await getChannelById(c.env.DB, channelId);
    if (channel) channels.push(channel);
    else missingIds.push(channelId);
  }
  return c.json({ channels, missing_ids: missingIds });
});

app.get("/series/:id/parts", async (c) => {
  const series = await getSeriesById(c.env.DB, c.req.param("id"));
  if (!series) {
    return c.json(errorBody("series_not_found", "no series with this id"), 404);
  }
  return c.json(await listParts(c.env.DB, series.id));
});

app.post("/series/:id/parts", async (c) => {
  const series = await getSeriesById(c.env.DB, c.req.param("id"));
  if (!series) {
    return c.json(errorBody("series_not_found", "no series with this id"), 404);
  }
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return c.json(errorBody("invalid_json", "request body must be JSON"), 400);
  }
  let validated;
  try {
    validated = validatePartCreate(body);
  } catch (err) {
    const mapped = seriesError(err);
    if (mapped) return c.json(errorBody(mapped.code, mapped.message), mapped.status as 400);
    throw err;
  }
  if (!(await getAssetById(c.env.DB, validated.assetId))) {
    return c.json(errorBody("asset_not_found", "no asset with this asset_id"), 404);
  }
  if (series.total_parts !== null && validated.partIndex > series.total_parts) {
    return c.json(
      errorBody(
        "part_beyond_total",
        `part_index ${validated.partIndex} exceeds the series total of ${series.total_parts}`,
      ),
      400,
    );
  }
  if (await getPartBySeriesAndIndex(c.env.DB, series.id, validated.partIndex)) {
    return c.json(
      errorBody("part_index_taken", `part ${validated.partIndex} is already attached`),
      409,
    );
  }
  if (await getPartByAssetId(c.env.DB, validated.assetId)) {
    return c.json(
      errorBody("asset_already_attached", "this asset is already attached to a part"),
      409,
    );
  }
  try {
    const part = await insertPart(c.env.DB, {
      id: crypto.randomUUID(),
      seriesId: series.id,
      ...validated,
    });
    return c.json(part, 201);
  } catch (err) {
    if (isPartConflict(err)) {
      return c.json(
        errorBody("part_conflict", "part_index or asset_id is already attached"),
        409,
      );
    }
    throw err;
  }
});

async function getOwnedPart(
  db: D1Database,
  seriesId: string,
  partId: string,
): Promise<{ status: "ok"; part: SeriesPart } | { status: number }> {
  const series = await getSeriesById(db, seriesId);
  if (!series) return { status: 404 };
  const part = await getPartById(db, partId);
  if (!part || part.series_id !== seriesId) return { status: 404 };
  return { status: "ok", part };
}

app.get("/series/:id/parts/:partId", async (c) => {
  const owned = await getOwnedPart(c.env.DB, c.req.param("id"), c.req.param("partId"));
  if (owned.status !== "ok") {
    return c.json(errorBody("part_not_found", "no such part in this series"), 404);
  }
  return c.json(owned.part);
});

app.patch("/series/:id/parts/:partId", async (c) => {
  const owned = await getOwnedPart(c.env.DB, c.req.param("id"), c.req.param("partId"));
  if (owned.status !== "ok") {
    return c.json(errorBody("part_not_found", "no such part in this series"), 404);
  }
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return c.json(errorBody("invalid_json", "request body must be JSON"), 400);
  }
  let validated;
  try {
    validated = validatePartPatch(body);
  } catch (err) {
    const mapped = seriesError(err);
    if (mapped) return c.json(errorBody(mapped.code, mapped.message), mapped.status as 400);
    throw err;
  }
  const series = await getSeriesById(c.env.DB, c.req.param("id"));
  if (validated.partIndex !== undefined && validated.partIndex !== owned.part.part_index) {
    if (series?.total_parts != null && validated.partIndex > series.total_parts) {
      return c.json(
        errorBody(
          "part_beyond_total",
          `part_index ${validated.partIndex} exceeds the series total of ${series.total_parts}`,
        ),
        400,
      );
    }
    const clash = await getPartBySeriesAndIndex(c.env.DB, c.req.param("id"), validated.partIndex);
    if (clash && clash.id !== c.req.param("partId")) {
      return c.json(
        errorBody("part_index_taken", `part ${validated.partIndex} is already attached`),
        409,
      );
    }
  }
  try {
    const part = await updatePart(c.env.DB, c.req.param("partId"), validated);
    if (!part) {
      return c.json(errorBody("part_not_found", "no such part in this series"), 404);
    }
    return c.json(part);
  } catch (err) {
    if (isPartConflict(err)) {
      return c.json(
        errorBody("part_conflict", "part_index or asset_id is already attached"),
        409,
      );
    }
    throw err;
  }
});

app.delete("/series/:id/parts/:partId", async (c) => {
  const owned = await getOwnedPart(c.env.DB, c.req.param("id"), c.req.param("partId"));
  if (owned.status !== "ok") {
    return c.json(errorBody("part_not_found", "no such part in this series"), 404);
  }
  await deletePart(c.env.DB, c.req.param("partId"));
  return c.body(null, 204);
});

app.get("/series/:id/parts/:partId/caption", async (c) => {
  const seriesId = c.req.param("id");
  const series = await getSeriesById(c.env.DB, seriesId);
  if (!series) {
    return c.json(errorBody("series_not_found", "no series with this id"), 404);
  }
  const part = await getPartById(c.env.DB, c.req.param("partId"));
  if (!part || part.series_id !== seriesId) {
    return c.json(errorBody("part_not_found", "no such part in this series"), 404);
  }
  let total = series.total_parts;
  if (total === null) {
    const stats = await seriesPartStats(c.env.DB, seriesId);
    total = stats.maxIndex ?? part.part_index;
  }
  try {
    const rendered = renderEpisode(
      {
        title_local: series.title_local,
        title_en: series.title_en,
        synopsis: series.synopsis,
        language: series.language,
        style_example: series.style_example,
        caption_template: series.caption_template,
        title_template: series.title_template,
        next_teaser_template: series.next_teaser_template,
        hashtags:
          typeof series.hashtags === "string" ? series.hashtags : normaliseHashtags(series.hashtags),
      },
      { part_index: part.part_index, total, hook: part.hook },
    );
    return c.json({
      ...rendered,
      within_limit: rendered.caption_length <= 1024,
      series_id: seriesId,
      part_id: part.id,
      asset_id: part.asset_id,
      part_index: part.part_index,
      total,
    });
  } catch (err) {
    if (err instanceof CaptionValidationError) {
      return c.json(errorBody(err.code, err.message), err.status as 400);
    }
    throw err;
  }
});

export default {
  fetch: app.fetch,
  /** Cron heartbeat arrives here every 15 min. Full slot tick lands in T6. */
  async scheduled(): Promise<void> {
    console.log("tick received: schedule release not implemented yet (T6)");
  },
};
