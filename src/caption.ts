/** Caption rendering for Telegram (T4). Pure strings in, strings out.
 *
 * Port of the sau-media `captions/template.py` path, simplified for a single
 * platform: Telegram has one caption field (0–1024 chars) and no title field.
 * The title line renders inside the caption template; `title_template` still
 * exists so the console can preview the title line on its own (T5 series
 * columns carry all three templates).
 *
 * Placeholders are `{name}`. Unknown names stay verbatim so an operator typo
 * shows up in the preview as itself, not as a silent hole. Empty values
 * collapse via `tidy` so a blank hook or a final episode's blank teaser
 * leaves no stranded blank lines. Over-long captions are `fit` to the
 * Telegram cap with an ellipsis, preferring a word boundary — and the render
 * result reports `truncated` so the console can warn instead of silently
 * shipping cut text.
 */

import { TELEGRAM_CAPTION_LIMIT } from "./telegram";

export const DEFAULT_CAPTION_TEMPLATE = "အပိုင်း ({part}) {series}\n\n{hook}\n\n{hashtags}";
export const DEFAULT_TITLE_TEMPLATE = "အပိုင်း ({part}) {series}";
export const DEFAULT_NEXT_TEASER_TEMPLATE = "";

export class CaptionValidationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "CaptionValidationError";
    this.code = code;
    this.status = status;
  }
}

/** Caption material for one series, detached from any DB row so the render
 * path stays testable without D1. `hashtags` is a plain string here: one
 * platform, one block (T5 stores the series JSON column; the route normalises
 * it to this shape before rendering). */
export interface SeriesCopy {
  title_local: string;
  title_en: string;
  synopsis: string;
  language: string;
  style_example: string;
  caption_template: string;
  title_template: string;
  next_teaser_template: string;
  hashtags: string;
}

export interface RenderInput {
  /** 1-based episode number. */
  part_index: number;
  /** Total episodes in the series. */
  total: number;
  /** Per-part hook line; the one paragraph under the title. */
  hook: string;
}

export interface RenderedEpisode {
  /** What `sendVideo` actually sends (always within the Telegram cap). */
  caption: string;
  /** Title line for console display only — Telegram has no title field. */
  title: string;
  /** Resolved teaser (empty on the final part, by design). */
  next_teaser: string;
  caption_length: number;
  /** Length before `fit`; lets the console warn when text was cut. */
  unfitted_length: number;
  truncated: boolean;
}

const FIELD_RE = /\{(\w+)\}/g;

/** Replace every known `{name}`, leaving unknown ones untouched. */
export function substitute(template: string, values: Record<string, string>): string {
  return template.replace(FIELD_RE, (match, name: string) =>
    Object.hasOwn(values, name) ? (values[name] as string) : match,
  );
}

/** Close the holes an empty placeholder leaves behind: runs of blank lines
 * collapse to one, trailing spaces go, outer blank lines are stripped. */
export function tidy(text: string): string {
  const lines = text.split("\n").map((line) => line.trimEnd());
  const out: string[] = [];
  for (const line of lines) {
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) {
      continue;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

/** Trim `text` to `limit` chars, preferring a clean break. Backs up to the
 * last space only when that costs less than a fifth of the budget — CJK runs
 * without spaces, so an unguarded backoff could discard most of a line. */
export function fit(text: string, limit: number): string {
  if (limit <= 0 || text.length <= limit) {
    return text;
  }
  const budget = limit - 1; // the ellipsis fits inside the limit
  const cut = text.slice(0, budget);
  const space = cut.lastIndexOf(" ");
  const trimmed = space > budget * 0.8 ? cut.slice(0, space) : cut;
  return `${trimmed.trimEnd()}…`;
}

/** Every placeholder a template may use, resolved for one part. `hashtags`
 * is passed through verbatim; per-platform selection is a sau-media concern
 * (one platform here). */
export function buildContext(
  copy: SeriesCopy,
  input: RenderInput,
): Record<string, string> {
  const hasNext = input.part_index < input.total;
  const base: Record<string, string> = {
    series: copy.title_local,
    series_en: copy.title_en,
    synopsis: copy.synopsis,
    part: String(input.part_index),
    total: String(input.total),
    next_part: hasNext ? String(input.part_index + 1) : "",
    hook: input.hook.trim(),
    hashtags: copy.hashtags,
  };
  // The teaser is itself a template, and renders empty on the last part:
  // the final episode must not promise a next one that never arrives.
  base["next_teaser"] = hasNext ? substitute(copy.next_teaser_template, base) : "";
  return base;
}

function assertRenderable(copy: SeriesCopy, input: RenderInput): void {
  if (!Number.isInteger(input.total) || input.total < 1) {
    throw new CaptionValidationError("invalid_total", "total must be a positive integer", 400);
  }
  if (!Number.isInteger(input.part_index) || input.part_index < 1 || input.part_index > input.total) {
    throw new CaptionValidationError(
      "invalid_part",
      `part_index must be an integer from 1 to ${input.total}`,
      400,
    );
  }
  if (typeof input.hook !== "string") {
    throw new CaptionValidationError("invalid_hook", "hook must be a string", 400);
  }
  for (const field of ["caption_template", "title_template", "next_teaser_template"] as const) {
    if (typeof copy[field] !== "string") {
      throw new CaptionValidationError("invalid_template", `${field} must be a string`, 400);
    }
  }
}

function withDefaults(copy: Partial<SeriesCopy>): SeriesCopy {
  return {
    title_local: copy.title_local ?? "",
    title_en: copy.title_en ?? "",
    synopsis: copy.synopsis ?? "",
    language: copy.language ?? "Burmese",
    style_example: copy.style_example ?? "",
    caption_template:
      copy.caption_template && copy.caption_template.trim() !== ""
        ? copy.caption_template
        : DEFAULT_CAPTION_TEMPLATE,
    title_template:
      copy.title_template && copy.title_template.trim() !== ""
        ? copy.title_template
        : DEFAULT_TITLE_TEMPLATE,
    next_teaser_template: copy.next_teaser_template ?? DEFAULT_NEXT_TEASER_TEMPLATE,
    hashtags: copy.hashtags ?? "",
  };
}

/** Render one part's caption (+ title-line preview) for Telegram. The
 * returned caption never exceeds 1024 chars; `truncated` tells the caller
 * text was cut so the console can warn rather than silently ship it. */
export function renderEpisode(
  copyInput: Partial<SeriesCopy>,
  input: RenderInput,
  limit: number = TELEGRAM_CAPTION_LIMIT,
): RenderedEpisode {
  const copy = withDefaults(copyInput);
  assertRenderable(copy, input);
  const values = buildContext(copy, input);
  const unfitted = tidy(substitute(copy.caption_template, values));
  const caption = fit(unfitted, limit);
  const title = tidy(substitute(copy.title_template, values));
  return {
    caption,
    title,
    next_teaser: values["next_teaser"] ?? "",
    caption_length: caption.length,
    unfitted_length: unfitted.length,
    truncated: unfitted.length > caption.length,
  };
}

/** Normalise the preview/series `hashtags` input: a plain string passes
 * through, a JSON object map uses its `telegram` key (sau-media shape), and
 * anything else becomes empty rather than crashing the render. */
export function normaliseHashtags(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    return typeof record["telegram"] === "string" ? (record["telegram"] as string) : "";
  }
  return "";
}
