/** Series + parts: validation + D1 helpers (T5).
 *
 * A series is a serialised show: many assets released in fixed episode order
 * with shared caption material (templates + hook per part, rendered by
 * `src/caption.ts`). `channel_ids` is the per-series channel pick — the
 * ordered list of `telegram_channels` ids this series publishes to (fanned
 * out into jobs by the T6 tick). Stale ids (channel deleted since) are
 * tolerated at read time and reported, never fatal.
 *
 * Storage notes (D1 is SQLite):
 *  - `hashtags` is TEXT: a JSON object is stored stringified, a plain string
 *    is stored raw. Reads parse leniently so both round-trip.
 *  - `channel_ids` is TEXT holding a JSON array of channel ids.
 *  - `total_parts` is nullable: unset until the operator knows the length.
 */

import { normaliseHashtags } from "./caption";
import { getChannelById } from "./channels";

export interface Series {
  id: string;
  slug: string;
  title_local: string;
  title_en: string;
  synopsis: string;
  language: string;
  style_example: string;
  total_parts: number | null;
  caption_template: string;
  title_template: string;
  next_teaser_template: string;
  hashtags: string | Record<string, string>;
  channel_ids: string[];
  created_at: string;
}

interface SeriesRow {
  id: string;
  slug: string;
  title_local: string;
  title_en: string;
  synopsis: string;
  language: string;
  style_example: string;
  total_parts: number | null;
  caption_template: string;
  title_template: string;
  next_teaser_template: string;
  hashtags: string;
  channel_ids: string;
  created_at: string;
}

export interface SeriesPart {
  id: string;
  series_id: string;
  asset_id: string;
  part_index: number;
  hook: string;
  source_filename: string;
  created_at: string;
}

interface SeriesPartRow {
  id: string;
  series_id: string;
  asset_id: string;
  part_index: number;
  hook: string;
  source_filename: string;
  created_at: string;
}

export class SeriesValidationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "SeriesValidationError";
    this.code = code;
    this.status = status;
  }
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_CHANNELS_PER_SERIES = 50;

function optionalText(raw: unknown, field: string, max: number, fallback = ""): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "string") {
    throw new SeriesValidationError("invalid_field", `${field} must be a string`, 400);
  }
  if (raw.length > max) {
    throw new SeriesValidationError(`${field}_too_long`, `${field} must be at most ${max} chars`, 400);
  }
  return raw;
}

function requiredSlug(raw: unknown): string {
  const slug = typeof raw === "string" ? raw.trim() : "";
  if (!slug) {
    throw new SeriesValidationError("missing_slug", "slug is required", 400);
  }
  if (slug.length > 80) {
    throw new SeriesValidationError("slug_too_long", "slug must be at most 80 chars", 400);
  }
  if (!SLUG_RE.test(slug)) {
    throw new SeriesValidationError(
      "invalid_slug",
      "slug must be lowercase kebab-case (e.g. my-show-s1)",
      400,
    );
  }
  return slug;
}

function optionalTotalParts(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 10000) {
    throw new SeriesValidationError(
      "invalid_total_parts",
      "total_parts must be a positive integer when provided",
      400,
    );
  }
  return raw;
}

/** Storage form of the hashtags input: objects are stringified, plain
 * strings are stored raw so they round-trip verbatim. */
export function encodeHashtags(raw: unknown): string {
  if (raw === undefined || raw === null) return "{}";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") clean[key] = value;
    }
    return JSON.stringify(clean);
  }
  throw new SeriesValidationError("invalid_hashtags", "hashtags must be a string or an object", 400);
}

/** Lenient read: JSON objects come back parsed, anything else raw. */
export function decodeHashtags(stored: string): string | Record<string, string> {
  if (stored.trimStart().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch {
      // Fall through to raw below.
    }
  }
  return stored;
}

/** The single hashtags string the caption renderer consumes. */
export function seriesHashtagsForRender(stored: string): string {
  const decoded = decodeHashtags(stored);
  return typeof decoded === "string" ? decoded : normaliseHashtags(decoded);
}

function decodeChannelIds(stored: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed)) {
      return parsed.filter((id): id is string => typeof id === "string" && id !== "");
    }
  } catch {
    // Corrupt value: behave as unpicked rather than crash the read.
  }
  return [];
}

function validateChannelIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every((id) => typeof id === "string" && id.trim() !== "")) {
    throw new SeriesValidationError(
      "invalid_channel_ids",
      "channel_ids must be an array of channel id strings",
      400,
    );
  }
  const deduped = [...new Set(raw as string[])];
  if (deduped.length > MAX_CHANNELS_PER_SERIES) {
    throw new SeriesValidationError(
      "too_many_channels",
      `at most ${MAX_CHANNELS_PER_SERIES} channels per series`,
      400,
    );
  }
  return deduped;
}

/** Reject ids that do not resolve to a channel (looped single-row reads so
 * the query shape stays stub-friendly). */
export async function assertChannelsExist(db: D1Database, ids: string[]): Promise<void> {
  for (const id of ids) {
    if (!(await getChannelById(db, id))) {
      throw new SeriesValidationError("channel_not_found", `no channel with id ${id}`, 400);
    }
  }
}

export interface ValidatedSeriesCreate {
  slug: string;
  titleLocal: string;
  titleEn: string;
  synopsis: string;
  language: string;
  styleExample: string;
  totalParts: number | null;
  captionTemplate: string;
  titleTemplate: string;
  nextTeaserTemplate: string;
  hashtagsText: string;
  channelIds: string[];
}

export function validateSeriesCreate(input: Record<string, unknown>): ValidatedSeriesCreate {
  return {
    slug: requiredSlug(input["slug"]),
    titleLocal: optionalText(input["title_local"], "title_local", 200),
    titleEn: optionalText(input["title_en"], "title_en", 200),
    synopsis: optionalText(input["synopsis"], "synopsis", 2000),
    language: optionalText(input["language"], "language", 40, "Burmese"),
    styleExample: optionalText(input["style_example"], "style_example", 2000),
    totalParts: optionalTotalParts(input["total_parts"]),
    captionTemplate: optionalText(input["caption_template"], "caption_template", 4000),
    titleTemplate: optionalText(input["title_template"], "title_template", 4000),
    nextTeaserTemplate: optionalText(
      input["next_teaser_template"],
      "next_teaser_template",
      4000,
    ),
    hashtagsText: encodeHashtags(input["hashtags"]),
    channelIds: validateChannelIds(input["channel_ids"]),
  };
}

export interface ValidatedSeriesPatch {
  slug?: string;
  titleLocal?: string;
  titleEn?: string;
  synopsis?: string;
  language?: string;
  styleExample?: string;
  totalParts?: number | null;
  captionTemplate?: string;
  titleTemplate?: string;
  nextTeaserTemplate?: string;
  hashtagsText?: string;
  channelIds?: string[];
}

export function validateSeriesPatch(input: Record<string, unknown>): ValidatedSeriesPatch {
  const out: ValidatedSeriesPatch = {};
  if (input["slug"] !== undefined) out.slug = requiredSlug(input["slug"]);
  if (input["title_local"] !== undefined)
    out.titleLocal = optionalText(input["title_local"], "title_local", 200);
  if (input["title_en"] !== undefined)
    out.titleEn = optionalText(input["title_en"], "title_en", 200);
  if (input["synopsis"] !== undefined)
    out.synopsis = optionalText(input["synopsis"], "synopsis", 2000);
  if (input["language"] !== undefined)
    out.language = optionalText(input["language"], "language", 40, "Burmese");
  if (input["style_example"] !== undefined)
    out.styleExample = optionalText(input["style_example"], "style_example", 2000);
  if (input["total_parts"] !== undefined) out.totalParts = optionalTotalParts(input["total_parts"]);
  if (input["caption_template"] !== undefined)
    out.captionTemplate = optionalText(input["caption_template"], "caption_template", 4000);
  if (input["title_template"] !== undefined)
    out.titleTemplate = optionalText(input["title_template"], "title_template", 4000);
  if (input["next_teaser_template"] !== undefined)
    out.nextTeaserTemplate = optionalText(
      input["next_teaser_template"],
      "next_teaser_template",
      4000,
    );
  if (input["hashtags"] !== undefined) out.hashtagsText = encodeHashtags(input["hashtags"]);
  if (input["channel_ids"] !== undefined) out.channelIds = validateChannelIds(input["channel_ids"]);
  if (Object.keys(out).length === 0) {
    throw new SeriesValidationError("empty_patch", "nothing to update", 400);
  }
  return out;
}

export interface ValidatedPartCreate {
  assetId: string;
  partIndex: number;
  hook: string;
  sourceFilename: string;
}

function requiredAssetId(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new SeriesValidationError("missing_asset_id", "asset_id is required", 400);
  }
  return raw;
}

function requiredPartIndex(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 10000) {
    throw new SeriesValidationError(
      "invalid_part_index",
      "part_index must be a positive integer",
      400,
    );
  }
  return raw;
}

export function validatePartCreate(input: Record<string, unknown>): ValidatedPartCreate {
  return {
    assetId: requiredAssetId(input["asset_id"]),
    partIndex: requiredPartIndex(input["part_index"]),
    hook: optionalText(input["hook"], "hook", 2000),
    sourceFilename: optionalText(input["source_filename"], "source_filename", 255),
  };
}

export interface ValidatedPartPatch {
  partIndex?: number;
  hook?: string;
  sourceFilename?: string;
}

export function validatePartPatch(input: Record<string, unknown>): ValidatedPartPatch {
  const out: ValidatedPartPatch = {};
  if (input["part_index"] !== undefined) out.partIndex = requiredPartIndex(input["part_index"]);
  if (input["hook"] !== undefined) out.hook = optionalText(input["hook"], "hook", 2000);
  if (input["source_filename"] !== undefined)
    out.sourceFilename = optionalText(input["source_filename"], "source_filename", 255);
  if (Object.keys(out).length === 0) {
    throw new SeriesValidationError("empty_patch", "nothing to update", 400);
  }
  return out;
}

const SERIES_COLS =
  "id, slug, title_local, title_en, synopsis, language, style_example, total_parts, caption_template, title_template, next_teaser_template, hashtags, channel_ids, created_at";

const PART_COLS = "id, series_id, asset_id, part_index, hook, source_filename, created_at";

function mapSeriesRow(row: SeriesRow): Series {
  return {
    id: row.id,
    slug: row.slug,
    title_local: row.title_local,
    title_en: row.title_en,
    synopsis: row.synopsis,
    language: row.language,
    style_example: row.style_example,
    total_parts: row.total_parts,
    caption_template: row.caption_template,
    title_template: row.title_template,
    next_teaser_template: row.next_teaser_template,
    hashtags: decodeHashtags(row.hashtags),
    channel_ids: decodeChannelIds(row.channel_ids),
    created_at: row.created_at,
  };
}

function mapPartRow(row: SeriesPartRow): SeriesPart {
  return {
    id: row.id,
    series_id: row.series_id,
    asset_id: row.asset_id,
    part_index: row.part_index,
    hook: row.hook,
    source_filename: row.source_filename,
    created_at: row.created_at,
  };
}

export async function listSeries(db: D1Database): Promise<Series[]> {
  const res = await db
    .prepare(`SELECT ${SERIES_COLS} FROM series ORDER BY created_at ASC, id ASC`)
    .all<SeriesRow>();
  return (res.results ?? []).map(mapSeriesRow);
}

export async function getSeriesById(db: D1Database, id: string): Promise<Series | null> {
  const row = await db
    .prepare(`SELECT ${SERIES_COLS} FROM series WHERE id = ?`)
    .bind(id)
    .first<SeriesRow>();
  return row ? mapSeriesRow(row) : null;
}

export async function getSeriesBySlug(db: D1Database, slug: string): Promise<Series | null> {
  const row = await db
    .prepare(`SELECT ${SERIES_COLS} FROM series WHERE slug = ?`)
    .bind(slug)
    .first<SeriesRow>();
  return row ? mapSeriesRow(row) : null;
}

export async function insertSeries(
  db: D1Database,
  row: { id: string } & ValidatedSeriesCreate,
): Promise<Series> {
  const created = await db
    .prepare(
      `INSERT INTO series (id, slug, title_local, title_en, synopsis, language, style_example, total_parts, caption_template, title_template, next_teaser_template, hashtags, channel_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${SERIES_COLS}`,
    )
    .bind(
      row.id,
      row.slug,
      row.titleLocal,
      row.titleEn,
      row.synopsis,
      row.language,
      row.styleExample,
      row.totalParts,
      row.captionTemplate,
      row.titleTemplate,
      row.nextTeaserTemplate,
      row.hashtagsText,
      JSON.stringify(row.channelIds),
    )
    .first<SeriesRow>();
  if (!created) {
    throw new Error("failed to insert series");
  }
  return mapSeriesRow(created);
}

export async function updateSeries(
  db: D1Database,
  id: string,
  patch: ValidatedSeriesPatch,
): Promise<Series | null> {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  const push = (col: string, value: string | number | null): void => {
    sets.push(`${col} = ?`);
    values.push(value);
  };
  if (patch.slug !== undefined) push("slug", patch.slug);
  if (patch.titleLocal !== undefined) push("title_local", patch.titleLocal);
  if (patch.titleEn !== undefined) push("title_en", patch.titleEn);
  if (patch.synopsis !== undefined) push("synopsis", patch.synopsis);
  if (patch.language !== undefined) push("language", patch.language);
  if (patch.styleExample !== undefined) push("style_example", patch.styleExample);
  if (patch.totalParts !== undefined) push("total_parts", patch.totalParts);
  if (patch.captionTemplate !== undefined) push("caption_template", patch.captionTemplate);
  if (patch.titleTemplate !== undefined) push("title_template", patch.titleTemplate);
  if (patch.nextTeaserTemplate !== undefined)
    push("next_teaser_template", patch.nextTeaserTemplate);
  if (patch.hashtagsText !== undefined) push("hashtags", patch.hashtagsText);
  if (patch.channelIds !== undefined) push("channel_ids", JSON.stringify(patch.channelIds));
  if (sets.length === 0) return getSeriesById(db, id);
  const updated = await db
    .prepare(`UPDATE series SET ${sets.join(", ")} WHERE id = ? RETURNING ${SERIES_COLS}`)
    .bind(...values, id)
    .first<SeriesRow>();
  return updated ? mapSeriesRow(updated) : null;
}

export async function deleteSeries(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM series WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

/** Part count + highest part_index, for guarding total_parts shrinks. */
export async function seriesPartStats(
  db: D1Database,
  seriesId: string,
): Promise<{ count: number; maxIndex: number | null }> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count, MAX(part_index) AS max_index FROM series_parts WHERE series_id = ?")
    .bind(seriesId)
    .first<{ count: number; max_index: number | null }>();
  return { count: row?.count ?? 0, maxIndex: row?.max_index ?? null };
}

export async function listParts(db: D1Database, seriesId: string): Promise<SeriesPart[]> {
  const res = await db
    .prepare(`SELECT ${PART_COLS} FROM series_parts WHERE series_id = ? ORDER BY part_index ASC`)
    .bind(seriesId)
    .all<SeriesPartRow>();
  return (res.results ?? []).map(mapPartRow);
}

export async function getPartById(db: D1Database, id: string): Promise<SeriesPart | null> {
  const row = await db
    .prepare(`SELECT ${PART_COLS} FROM series_parts WHERE id = ?`)
    .bind(id)
    .first<SeriesPartRow>();
  return row ? mapPartRow(row) : null;
}

export async function getPartBySeriesAndIndex(
  db: D1Database,
  seriesId: string,
  partIndex: number,
): Promise<SeriesPart | null> {
  const row = await db
    .prepare(`SELECT ${PART_COLS} FROM series_parts WHERE series_id = ? AND part_index = ?`)
    .bind(seriesId, partIndex)
    .first<SeriesPartRow>();
  return row ? mapPartRow(row) : null;
}

export async function getPartByAssetId(db: D1Database, assetId: string): Promise<SeriesPart | null> {
  const row = await db
    .prepare(`SELECT ${PART_COLS} FROM series_parts WHERE asset_id = ?`)
    .bind(assetId)
    .first<SeriesPartRow>();
  return row ? mapPartRow(row) : null;
}

export async function insertPart(
  db: D1Database,
  row: { id: string; seriesId: string } & ValidatedPartCreate,
): Promise<SeriesPart> {
  const created = await db
    .prepare(
      `INSERT INTO series_parts (id, series_id, asset_id, part_index, hook, source_filename)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING ${PART_COLS}`,
    )
    .bind(row.id, row.seriesId, row.assetId, row.partIndex, row.hook, row.sourceFilename)
    .first<SeriesPartRow>();
  if (!created) {
    throw new Error("failed to insert series part");
  }
  return mapPartRow(created);
}

export async function updatePart(
  db: D1Database,
  id: string,
  patch: ValidatedPartPatch,
): Promise<SeriesPart | null> {
  const sets: string[] = [];
  const values: Array<string | number> = [];
  if (patch.partIndex !== undefined) {
    sets.push("part_index = ?");
    values.push(patch.partIndex);
  }
  if (patch.hook !== undefined) {
    sets.push("hook = ?");
    values.push(patch.hook);
  }
  if (patch.sourceFilename !== undefined) {
    sets.push("source_filename = ?");
    values.push(patch.sourceFilename);
  }
  if (sets.length === 0) return getPartById(db, id);
  const updated = await db
    .prepare(`UPDATE series_parts SET ${sets.join(", ")} WHERE id = ? RETURNING ${PART_COLS}`)
    .bind(...values, id)
    .first<SeriesPartRow>();
  return updated ? mapPartRow(updated) : null;
}

export async function deletePart(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM series_parts WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

/** True when the D1 error is a UNIQUE violation on `series.slug`. */
export function isSlugConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed: series\.slug/i.test(msg);
}

/** True when the D1 error is any UNIQUE violation on `series_parts`. */
export function isPartConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed: series_parts\./i.test(msg);
}
