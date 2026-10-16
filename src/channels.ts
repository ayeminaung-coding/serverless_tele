/** Telegram channels: validation + D1 helpers (T3).
 *
 * One row per channel the Worker may post to. `chat_id` is the Bot API
 * identifier the operator pastes in: `@publicname` for public channels,
 * `-100…` (or any numeric id) for private ones. The bot must be admin there;
 * `POST /channels/:id/verify` checks that via `getChat`.
 *
 * API shape uses booleans; D1 stores INTEGER 0/1 (SQLite has no bool).
 */

export interface Channel {
  id: string;
  label: string;
  chat_id: string;
  is_public: boolean;
  protect_content: boolean;
  enabled: boolean;
  created_at: string;
}

interface ChannelRow {
  id: string;
  label: string;
  chat_id: string;
  is_public: number;
  protect_content: number;
  enabled: number;
  created_at: string;
}

export class ChannelValidationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ChannelValidationError";
    this.code = code;
    this.status = status;
  }
}

const PUBLIC_HANDLE = /^@[A-Za-z0-9_]{5,32}$/;
const NUMERIC_CHAT_ID = /^-?\d+$/;

/** Normalize + validate a pasted chat_id. Returns the trimmed value. */
export function validateChatId(raw: unknown): string {
  const chatId = typeof raw === "string" ? raw.trim() : "";
  if (!chatId) {
    throw new ChannelValidationError("missing_chat_id", "chat_id is required", 400);
  }
  if (PUBLIC_HANDLE.test(chatId) || NUMERIC_CHAT_ID.test(chatId)) {
    return chatId;
  }
  throw new ChannelValidationError(
    "invalid_chat_id",
    "chat_id must be a public @handle or a numeric id like -1001234567890",
    400,
  );
}

function validateLabel(raw: unknown): string {
  const label = typeof raw === "string" ? raw.trim() : "";
  if (!label) {
    throw new ChannelValidationError("missing_label", "label is required", 400);
  }
  if (label.length > 120) {
    throw new ChannelValidationError("label_too_long", "label must be at most 120 chars", 400);
  }
  return label;
}

function toBool(raw: unknown, field: string, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw === "boolean") return raw;
  throw new ChannelValidationError(
    "invalid_flag",
    `${field} must be a boolean when provided`,
    400,
  );
}

export interface ChannelCreateInput {
  label: unknown;
  chat_id: unknown;
  is_public?: unknown;
  protect_content?: unknown;
  enabled?: unknown;
}

export interface ValidatedChannelCreate {
  label: string;
  chatId: string;
  isPublic: boolean;
  protectContent: boolean;
  enabled: boolean;
}

export function validateChannelCreate(input: ChannelCreateInput): ValidatedChannelCreate {
  return {
    label: validateLabel(input.label),
    chatId: validateChatId(input.chat_id),
    isPublic: toBool(input.is_public, "is_public", false),
    protectContent: toBool(input.protect_content, "protect_content", false),
    enabled: toBool(input.enabled, "enabled", true),
  };
}

export type ChannelPatchInput = Partial<ChannelCreateInput>;

export interface ValidatedChannelPatch {
  label?: string;
  chatId?: string;
  isPublic?: boolean;
  protectContent?: boolean;
  enabled?: boolean;
}

export function validateChannelPatch(input: ChannelPatchInput): ValidatedChannelPatch {
  const out: ValidatedChannelPatch = {};
  if (input.label !== undefined) out.label = validateLabel(input.label);
  if (input.chat_id !== undefined) out.chatId = validateChatId(input.chat_id);
  if (input.is_public !== undefined) out.isPublic = toBool(input.is_public, "is_public", false);
  if (input.protect_content !== undefined)
    out.protectContent = toBool(input.protect_content, "protect_content", false);
  if (input.enabled !== undefined) out.enabled = toBool(input.enabled, "enabled", true);
  if (Object.keys(out).length === 0) {
    throw new ChannelValidationError("empty_patch", "nothing to update", 400);
  }
  return out;
}

export function mapChannelRow(row: ChannelRow): Channel {
  return {
    id: row.id,
    label: row.label,
    chat_id: row.chat_id,
    is_public: row.is_public === 1,
    protect_content: row.protect_content === 1,
    enabled: row.enabled === 1,
    created_at: row.created_at,
  };
}

const SELECT_COLS =
  "id, label, chat_id, is_public, protect_content, enabled, created_at";

export async function listChannels(db: D1Database): Promise<Channel[]> {
  const res = await db
    .prepare(`SELECT ${SELECT_COLS} FROM telegram_channels ORDER BY created_at ASC, id ASC`)
    .all<ChannelRow>();
  return (res.results ?? []).map(mapChannelRow);
}

export async function getChannelById(db: D1Database, id: string): Promise<Channel | null> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLS} FROM telegram_channels WHERE id = ?`)
    .bind(id)
    .first<ChannelRow>();
  return row ? mapChannelRow(row) : null;
}

export async function insertChannel(
  db: D1Database,
  row: { id: string } & ValidatedChannelCreate,
): Promise<Channel> {
  const created = await db
    .prepare(
      `INSERT INTO telegram_channels (id, label, chat_id, is_public, protect_content, enabled)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING ${SELECT_COLS}`,
    )
    .bind(
      row.id,
      row.label,
      row.chatId,
      row.isPublic ? 1 : 0,
      row.protectContent ? 1 : 0,
      row.enabled ? 1 : 0,
    )
    .first<ChannelRow>();
  if (!created) {
    throw new Error("failed to insert channel");
  }
  return mapChannelRow(created);
}

/** Returns null when the id does not exist. */
export async function updateChannel(
  db: D1Database,
  id: string,
  patch: ValidatedChannelPatch,
): Promise<Channel | null> {
  const sets: string[] = [];
  const values: Array<string | number> = [];
  if (patch.label !== undefined) {
    sets.push("label = ?");
    values.push(patch.label);
  }
  if (patch.chatId !== undefined) {
    sets.push("chat_id = ?");
    values.push(patch.chatId);
  }
  if (patch.isPublic !== undefined) {
    sets.push("is_public = ?");
    values.push(patch.isPublic ? 1 : 0);
  }
  if (patch.protectContent !== undefined) {
    sets.push("protect_content = ?");
    values.push(patch.protectContent ? 1 : 0);
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    values.push(patch.enabled ? 1 : 0);
  }
  if (sets.length === 0) return getChannelById(db, id);
  const updated = await db
    .prepare(`UPDATE telegram_channels SET ${sets.join(", ")} WHERE id = ? RETURNING ${SELECT_COLS}`)
    .bind(...values, id)
    .first<ChannelRow>();
  return updated ? mapChannelRow(updated) : null;
}

export async function deleteChannel(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM telegram_channels WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

/** True when the underlying D1 error is a UNIQUE violation on chat_id. */
export function isChatIdConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed: telegram_channels\.chat_id/i.test(msg);
}
