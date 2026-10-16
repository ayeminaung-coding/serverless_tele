/** Slots + ordered backlog + tick release (T6).
 *
 * Slot helpers, job helpers, and the tick core shared by `POST /tick` and
 * the cron `scheduled()` handler. The core takes injected `nowMs` and
 * `fetchImpl` so tests never touch the network or wall clock.
 *
 * Reuse rules: delivery goes through `sendVideo`/`TelegramApiError` from
 * `src/telegram.ts`; captions through `renderPartCaption` from
 * `src/caption.ts`; series/channel/asset/part reads through their modules.
 * No new SQL for those tables lives here.
 */

import { renderPartCaption } from "./caption";
import { getChannelById } from "./channels";
import { getAssetById } from "./db";
import {
  getPartByAssetId,
  getSeriesById,
  listParts,
  listSeries,
  seriesPartStats,
} from "./series";
import { TelegramApiError, sendVideo } from "./telegram";

export type JobState = "scheduled" | "published" | "failed";

export interface Slot {
  id: string;
  label: string;
  hour: number;
  minute: number;
  timezone: string;
  enabled: boolean;
  last_fired_on: string | null;
  created_at: string;
}

interface SlotRow {
  id: string;
  label: string;
  hour: number;
  minute: number;
  timezone: string;
  enabled: number;
  last_fired_on: string | null;
  created_at: string;
}

export class SlotValidationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "SlotValidationError";
    this.code = code;
    this.status = status;
  }
}

/** This Worker's half of the cron contract: the DB binding, the bot token,
 * and the public R2 base the video URLs are built from. Structurally
 * satisfied by the Hono `Env` in `src/index.ts`. */
export interface TickEnv {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  R2_PUBLIC_BASE_URL?: string;
}

/** Current date + wall time inside one IANA timezone, from a single `Intl`
 * source so the day fence and the time fence can never disagree. `date` is
 * `YYYY-MM-DD`. Throws `RangeError` for an unknown timezone. */
export function zonedParts(
  ms: number,
  timeZone: string,
): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  // hour12:false renders midnight as "24" — normalise back to 0.
  const hour = Number(get("hour")) % 24;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour, minute: Number(get("minute")) };
}

/** A slot is due when it is enabled, has not fired yet today (in its own
 * timezone), and its hour:minute is at or before now (same timezone). */
export function isSlotDue(slot: Slot, nowMs: number): boolean {
  if (!slot.enabled) return false;
  const now = zonedParts(nowMs, slot.timezone);
  if (slot.last_fired_on !== null && slot.last_fired_on === now.date) return false;
  if (slot.hour > now.hour) return false;
  if (slot.hour === now.hour && slot.minute > now.minute) return false;
  return true;
}

export interface ValidatedSlotPatch {
  label?: string;
  hour?: number;
  minute?: number;
  timezone?: string;
  enabled?: boolean;
}

export function validateSlotPatch(input: Record<string, unknown>): ValidatedSlotPatch {
  const out: ValidatedSlotPatch = {};
  if (input["label"] !== undefined) {
    const label = input["label"];
    if (typeof label !== "string" || label.length > 120) {
      throw new SlotValidationError(
        "invalid_label",
        "label must be a string of at most 120 chars",
        400,
      );
    }
    out.label = label;
  }
  if (input["hour"] !== undefined) {
    const hour = input["hour"];
    if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new SlotValidationError("invalid_hour", "hour must be an integer from 0 to 23", 400);
    }
    out.hour = hour;
  }
  if (input["minute"] !== undefined) {
    const minute = input["minute"];
    if (typeof minute !== "number" || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new SlotValidationError(
        "invalid_minute",
        "minute must be an integer from 0 to 59",
        400,
      );
    }
    out.minute = minute;
  }
  if (input["timezone"] !== undefined) {
    const timezone = input["timezone"];
    if (typeof timezone !== "string" || timezone.trim() === "") {
      throw new SlotValidationError("invalid_timezone", "timezone must be a non-empty string", 400);
    }
    try {
      // Throws RangeError for unknown zones — that is the whole check.
      new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    } catch {
      throw new SlotValidationError("invalid_timezone", `unknown timezone ${timezone}`, 400);
    }
    out.timezone = timezone;
  }
  if (input["enabled"] !== undefined) {
    if (typeof input["enabled"] !== "boolean") {
      throw new SlotValidationError(
        "invalid_enabled",
        "enabled must be a boolean when provided",
        400,
      );
    }
    out.enabled = input["enabled"];
  }
  if (Object.keys(out).length === 0) {
    throw new SlotValidationError("empty_patch", "nothing to update", 400);
  }
  return out;
}

const SLOT_COLS = "id, label, hour, minute, timezone, enabled, last_fired_on, created_at";

function mapSlotRow(row: SlotRow): Slot {
  return {
    id: row.id,
    label: row.label,
    hour: row.hour,
    minute: row.minute,
    timezone: row.timezone,
    enabled: row.enabled === 1,
    last_fired_on: row.last_fired_on,
    created_at: row.created_at,
  };
}

export async function listSlots(db: D1Database): Promise<Slot[]> {
  const res = await db
    .prepare(`SELECT ${SLOT_COLS} FROM schedule_slots ORDER BY hour ASC, minute ASC, id ASC`)
    .all<SlotRow>();
  return (res.results ?? []).map(mapSlotRow);
}

export async function getSlotById(db: D1Database, id: string): Promise<Slot | null> {
  const row = await db
    .prepare(`SELECT ${SLOT_COLS} FROM schedule_slots WHERE id = ?`)
    .bind(id)
    .first<SlotRow>();
  return row ? mapSlotRow(row) : null;
}

/** Partial slot retune. Returns null when the id is unknown. */
export async function updateSlot(
  db: D1Database,
  id: string,
  patch: ValidatedSlotPatch,
): Promise<Slot | null> {
  const sets: string[] = [];
  const values: Array<string | number> = [];
  if (patch.label !== undefined) {
    sets.push("label = ?");
    values.push(patch.label);
  }
  if (patch.hour !== undefined) {
    sets.push("hour = ?");
    values.push(patch.hour);
  }
  if (patch.minute !== undefined) {
    sets.push("minute = ?");
    values.push(patch.minute);
  }
  if (patch.timezone !== undefined) {
    sets.push("timezone = ?");
    values.push(patch.timezone);
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    values.push(patch.enabled ? 1 : 0);
  }
  if (sets.length === 0) return getSlotById(db, id);
  const updated = await db
    .prepare(`UPDATE schedule_slots SET ${sets.join(", ")} WHERE id = ? RETURNING ${SLOT_COLS}`)
    .bind(...values, id)
    .first<SlotRow>();
  return updated ? mapSlotRow(updated) : null;
}

/** At-most-once fence: record that a due slot was processed for this date. */
export async function markSlotFired(db: D1Database, id: string, date: string): Promise<void> {
  await db.prepare("UPDATE schedule_slots SET last_fired_on = ? WHERE id = ?").bind(date, id).run();
}

export interface PublishJob {
  id: string;
  asset_id: string;
  channel_id: string | null;
  chat_id_snapshot: string;
  caption: string;
  state: JobState;
  external_id: string | null;
  external_url: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  id: string;
  asset_id: string;
  channel_id: string | null;
  chat_id_snapshot: string;
  caption: string;
  state: string;
  external_id: string | null;
  external_url: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const JOB_COLS =
  "id, asset_id, channel_id, chat_id_snapshot, caption, state, external_id, external_url, attempts, last_error, created_at, updated_at";

function mapJobRow(row: JobRow): PublishJob {
  return {
    id: row.id,
    asset_id: row.asset_id,
    channel_id: row.channel_id,
    chat_id_snapshot: row.chat_id_snapshot,
    caption: row.caption,
    state: row.state as JobState,
    external_id: row.external_id,
    external_url: row.external_url,
    attempts: row.attempts,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getJobById(db: D1Database, id: string): Promise<PublishJob | null> {
  const row = await db
    .prepare(`SELECT ${JOB_COLS} FROM publish_jobs WHERE id = ?`)
    .bind(id)
    .first<JobRow>();
  return row ? mapJobRow(row) : null;
}

/** Idempotency lookup: at most one job per (asset, channel). */
export async function findJob(
  db: D1Database,
  assetId: string,
  channelId: string,
): Promise<PublishJob | null> {
  const row = await db
    .prepare(`SELECT ${JOB_COLS} FROM publish_jobs WHERE asset_id = ? AND channel_id = ?`)
    .bind(assetId, channelId)
    .first<JobRow>();
  return row ? mapJobRow(row) : null;
}

export async function insertJob(
  db: D1Database,
  row: {
    id: string;
    assetId: string;
    channelId: string;
    chatIdSnapshot: string;
    caption: string;
  },
): Promise<PublishJob> {
  try {
    const created = await db
      .prepare(
        `INSERT INTO publish_jobs (id, asset_id, channel_id, chat_id_snapshot, caption, state)
         VALUES (?, ?, ?, ?, ?, 'scheduled')
         RETURNING ${JOB_COLS}`,
      )
      .bind(row.id, row.assetId, row.channelId, row.chatIdSnapshot, row.caption)
      .first<JobRow>();
    if (!created) {
      throw new Error("failed to insert publish job");
    }
    return mapJobRow(created);
  } catch (err) {
    // The UNIQUE(asset_id, channel_id) is the backstop for a lost race:
    // reuse the winner instead of surfacing a 500.
    if (isJobConflict(err)) {
      const existing = await findJob(db, row.assetId, row.channelId);
      if (existing) return existing;
    }
    throw err;
  }
}

export interface MarkJobPatch {
  state: JobState;
  attempts: number;
  lastError: string | null;
  externalId: string | null;
}

/** Single-shape job transition; keeps `updated_at` fresh. */
export async function markJob(
  db: D1Database,
  id: string,
  patch: MarkJobPatch,
): Promise<PublishJob | null> {
  const updated = await db
    .prepare(
      `UPDATE publish_jobs SET state = ?, attempts = ?, last_error = ?, external_id = ?, updated_at = ? WHERE id = ? RETURNING ${JOB_COLS}`,
    )
    .bind(patch.state, patch.attempts, patch.lastError, patch.externalId, new Date().toISOString(), id)
    .first<JobRow>();
  return updated ? mapJobRow(updated) : null;
}

export async function listJobs(
  db: D1Database,
  opts: { state?: JobState; limit: number },
): Promise<PublishJob[]> {
  const order = "ORDER BY created_at ASC, id ASC LIMIT ?";
  const res =
    opts.state !== undefined
      ? await db
          .prepare(`SELECT ${JOB_COLS} FROM publish_jobs WHERE state = ? ${order}`)
          .bind(opts.state, opts.limit)
          .all<JobRow>()
      : await db
          .prepare(`SELECT ${JOB_COLS} FROM publish_jobs ${order}`)
          .bind(opts.limit)
          .all<JobRow>();
  return (res.results ?? []).map(mapJobRow);
}

export interface EnrichedJob extends PublishJob {
  storage_key: string | null;
  series: { id: string; slug: string } | null;
  part_index: number | null;
}

export interface JobListFilter {
  state?: JobState;
  seriesId?: string;
  channelId?: string;
  limit?: number;
}

export const DEFAULT_JOB_LIMIT = 50;
export const MAX_JOB_LIMIT = 200;

/** Job list joined in code (stub-friendly single-table reads): asset
 * `storage_key`, owning series `{id, slug}`, and `part_index` via
 * `series_parts` by `asset_id`. `series_id`/`channel_id` narrow after the
 * join, then the result is sliced to `limit` — so when those filters are
 * present the underlying fetch over-reads (up to MAX) to keep the limit
 * honest. */
export async function listJobsEnriched(
  db: D1Database,
  filter: JobListFilter = {},
): Promise<EnrichedJob[]> {
  const limit = filter.limit ?? DEFAULT_JOB_LIMIT;
  const needsPostFilter = filter.seriesId !== undefined || filter.channelId !== undefined;
  const rows = await listJobs(db, {
    state: filter.state,
    limit: needsPostFilter ? MAX_JOB_LIMIT : limit,
  });
  const out: EnrichedJob[] = [];
  for (const job of rows) {
    const asset = await getAssetById(db, job.asset_id);
    const part = await getPartByAssetId(db, job.asset_id);
    const series = part ? await getSeriesById(db, part.series_id) : null;
    const enriched: EnrichedJob = {
      ...job,
      storage_key: asset ? asset.storage_key : null,
      series: series ? { id: series.id, slug: series.slug } : null,
      part_index: part ? part.part_index : null,
    };
    if (filter.seriesId !== undefined && enriched.series?.id !== filter.seriesId) continue;
    if (filter.channelId !== undefined && enriched.channel_id !== filter.channelId) continue;
    out.push(enriched);
  }
  return out.slice(0, limit);
}

/** Asset ids already delivered to one channel — the per-(series, channel)
 * progress input. Channels stay independent: one channel's failure or late
 * subscription never shifts another's episode order. */
export async function listPublishedAssetIds(
  db: D1Database,
  channelId: string,
): Promise<Set<string>> {
  const res = await db
    .prepare("SELECT asset_id FROM publish_jobs WHERE channel_id = ? AND state = 'published'")
    .bind(channelId)
    .all<{ asset_id: string }>();
  return new Set((res.results ?? []).map((r) => r.asset_id));
}

export type JobOutcome = "published" | "failed" | "deferred";

/** One delivery attempt for an already-ensured job: guardrails, one
 * `sendVideo`, outcome mapping. Never throws for send-side failures — they
 * become row state + the returned outcome. */
export async function sendJob(
  env: TickEnv,
  job: PublishJob,
  channel: { protect_content: boolean },
  asset: { storage_key: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ job: PublishJob; outcome: JobOutcome; error?: string }> {
  const token = env.TELEGRAM_BOT_TOKEN ?? "";
  const base = env.R2_PUBLIC_BASE_URL ?? "";
  if (!token || !base) {
    const reason = !token
      ? "TELEGRAM_BOT_TOKEN is not configured"
      : "R2_PUBLIC_BASE_URL is not configured";
    const updated = await markJob(env.DB, job.id, {
      state: "scheduled",
      attempts: job.attempts,
      lastError: reason,
      externalId: job.external_id,
    });
    return { job: updated ?? job, outcome: "deferred", error: reason };
  }
  const video = `${base.replace(/\/+$/, "")}/${asset.storage_key}`;
  try {
    const message = await sendVideo(
      token,
      {
        chat_id: job.chat_id_snapshot,
        video,
        caption: job.caption,
        protect_content: channel.protect_content,
      },
      fetchImpl,
    );
    const updated = await markJob(env.DB, job.id, {
      state: "published",
      attempts: job.attempts + 1,
      lastError: null,
      externalId: String(message.message_id),
    });
    return { job: updated ?? job, outcome: "published" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      err instanceof TelegramApiError &&
      (err.code === "telegram_rate_limited" || err.code === "telegram_unreachable")
    ) {
      // Retryable: a later tick picks the row up again.
      const updated = await markJob(env.DB, job.id, {
        state: "scheduled",
        attempts: job.attempts + 1,
        lastError: message,
        externalId: job.external_id,
      });
      return { job: updated ?? job, outcome: "deferred", error: message };
    }
    // Forbidden / other API errors: the operator fixes token or admin
    // rights, then POST /jobs/:id/retry.
    const updated = await markJob(env.DB, job.id, {
      state: "failed",
      attempts: job.attempts + 1,
      lastError: message,
      externalId: job.external_id,
    });
    return { job: updated ?? job, outcome: "failed", error: message };
  }
}

export interface TickSummary {
  fired_slots: string[];
  jobs_created: number;
  published: number;
  failed: number;
  deferred: number;
  errors: string[];
}

export interface TickOptions {
  nowMs?: number;
  fetchImpl?: typeof fetch;
}

/** Full tick: due slots → per-series/per-channel progress → ensure-then-send
 * → fire-marking → summary. Safe to call any time (no due slots → zeros).
 * One bad series/channel never aborts the tick; its note lands in `errors`
 * and the due slots are still fire-marked (recovery is via job retry). */
export async function runTick(env: TickEnv, opts: TickOptions = {}): Promise<TickSummary> {
  const nowMs = opts.nowMs ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const summary: TickSummary = {
    fired_slots: [],
    jobs_created: 0,
    published: 0,
    failed: 0,
    deferred: 0,
    errors: [],
  };
  const slots = await listSlots(env.DB);
  const due: Slot[] = [];
  for (const slot of slots) {
    try {
      if (isSlotDue(slot, nowMs)) due.push(slot);
    } catch (err) {
      summary.errors.push(`slot ${slot.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (due.length === 0) return summary;

  const allSeries = await listSeries(env.DB);
  for (const series of allSeries) {
    if (series.channel_ids.length === 0) continue;
    for (const channelId of series.channel_ids) {
      try {
        const channel = await getChannelById(env.DB, channelId);
        // Missing (deleted since picked) or disabled: skip silently.
        if (!channel || !channel.enabled) continue;
        const parts = await listParts(env.DB, series.id);
        if (parts.length === 0) continue;
        const publishedAssets = await listPublishedAssetIds(env.DB, channel.id);
        let progress = 0;
        for (const part of parts) {
          if (publishedAssets.has(part.asset_id) && part.part_index > progress) {
            progress = part.part_index;
          }
        }
        const next = parts.find((part) => part.part_index === progress + 1);
        // No such part: this series is fully released on this channel.
        if (!next) continue;
        const existing = await findJob(env.DB, next.asset_id, channel.id);
        // Already sent, or failed and waiting on an explicit retry.
        if (existing && existing.state !== "scheduled") continue;
        let job = existing;
        if (!job) {
          let total = series.total_parts;
          if (total === null) {
            const stats = await seriesPartStats(env.DB, series.id);
            total = stats.maxIndex ?? next.part_index;
          }
          const rendered = renderPartCaption(series, next, total);
          job = await insertJob(env.DB, {
            id: crypto.randomUUID(),
            assetId: next.asset_id,
            channelId: channel.id,
            chatIdSnapshot: channel.chat_id,
            caption: rendered.caption,
          });
          summary.jobs_created += 1;
        }
        const asset = await getAssetById(env.DB, next.asset_id);
        if (!asset) {
          summary.errors.push(
            `series ${series.id} part ${next.part_index}: asset ${next.asset_id} is missing`,
          );
          continue;
        }
        const result = await sendJob(env, job, channel, asset, fetchImpl);
        if (result.outcome === "published") {
          summary.published += 1;
        } else if (result.outcome === "failed") {
          summary.failed += 1;
          if (result.error) summary.errors.push(result.error);
        } else {
          summary.deferred += 1;
          if (result.error) summary.errors.push(result.error);
        }
      } catch (err) {
        summary.errors.push(
          `series ${series.id} channel ${channelId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  for (const slot of due) {
    await markSlotFired(env.DB, slot.id, zonedParts(nowMs, slot.timezone).date);
    summary.fired_slots.push(slot.id);
  }
  return summary;
}

/** True when the underlying D1 error is a UNIQUE violation on `publish_jobs`. */
export function isJobConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed: publish_jobs\./i.test(msg);
}
