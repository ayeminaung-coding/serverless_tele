/** Telegram Bot API transport (T3).
 *
 * Thin fetch wrapper around `sendVideo` (plus `getChat` for channel
 * verification). Mirrors the sau-media adapter split: this module is pure
 * transport — request shaping, `ok:false` unwrapping, and error mapping.
 * Caption assembly and publish flow land in T4/T6.
 *
 * Error contract:
 *  - 429 or `retry_after` in parameters → retryable, `retryAfterSeconds` set.
 *  - 401/403 (unauthorized / bot blocked / not admin) → `code` preserved,
 *    `retryable: false` (operator must fix token or admin rights).
 *  - Everything else → `TelegramApiError` with Telegram's description.
 */

export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Media captions are 0-1024 chars after entities parsing. There is no title
 * field; the title line renders inside the caption template instead. */
export const TELEGRAM_CAPTION_LIMIT = 1024;

export interface SendVideoParams {
  chat_id: string;
  /** Public HTTPS URL Telegram fetches from (our R2 public URL in T6). */
  video: string;
  caption?: string;
  parse_mode?: "HTML" | "MarkdownV2";
  supports_streaming?: boolean;
  disable_notification?: boolean;
  protect_content?: boolean;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number | string; type?: string; title?: string; username?: string };
  caption?: string;
  video?: { file_id: string; file_unique_id: string; duration?: number };
}

export interface TelegramChat {
  id: number | string;
  type?: string;
  title?: string;
  username?: string;
}

export class TelegramApiError extends Error {
  readonly code: string;
  /** HTTP status from Bot API (401/403/429/400...), 0 when transport-level. */
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(
    code: string,
    message: string,
    opts: { status?: number; retryable?: boolean; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "TelegramApiError";
    this.code = code;
    this.status = opts.status ?? 0;
    this.retryable = opts.retryable ?? false;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

type FetchImpl = typeof fetch;

interface ApiEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export function telegramMethodUrl(botToken: string, method: string): string {
  return `${TELEGRAM_API_BASE}/bot${botToken}/${method}`;
}

function assertToken(botToken: string): void {
  if (!botToken) {
    throw new TelegramApiError("bot_token_missing", "TELEGRAM_BOT_TOKEN is not configured", {
      status: 0,
      retryable: false,
    });
  }
}

async function callMethod<T>(
  botToken: string,
  method: string,
  payload: unknown,
  fetchImpl: FetchImpl = fetch,
): Promise<T> {
  assertToken(botToken);
  let res: Response;
  try {
    res = await fetchImpl(telegramMethodUrl(botToken, method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new TelegramApiError(
      "telegram_unreachable",
      `could not reach Telegram Bot API: ${(err as Error).message}`,
      { retryable: true },
    );
  }

  let envelope: ApiEnvelope<T> | null = null;
  try {
    envelope = (await res.json()) as ApiEnvelope<T>;
  } catch {
    // Non-JSON (proxy/CF HTML error page): map by HTTP status.
    throw new TelegramApiError("telegram_bad_response", `Telegram returned HTTP ${res.status}`, {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
    });
  }

  if (envelope && envelope.ok && envelope.result !== undefined) {
    return envelope.result;
  }

  const description = envelope?.description ?? `Telegram returned HTTP ${res.status}`;
  const errorCode = envelope?.error_code ?? res.status;
  const retryAfter = envelope?.parameters?.retry_after;
  if (typeof retryAfter === "number" && retryAfter > 0) {
    return Promise.reject(
      new TelegramApiError("telegram_rate_limited", description, {
        status: errorCode,
        retryable: true,
        retryAfterSeconds: retryAfter,
      }),
    );
  }
  if (errorCode === 429) {
    throw new TelegramApiError("telegram_rate_limited", description, {
      status: 429,
      retryable: true,
      retryAfterSeconds: typeof retryAfter === "number" ? retryAfter : undefined,
    });
  }
  if (errorCode === 401 || errorCode === 403) {
    throw new TelegramApiError("telegram_forbidden", description, {
      status: errorCode,
      retryable: false,
    });
  }
  throw new TelegramApiError("telegram_api_error", description, {
    status: errorCode,
    retryable: errorCode >= 500,
  });
}

/** Send a video by URL. Caller passes the per-channel `protect_content` flag
 * through (paid private channels set it). Caption is length-checked locally
 * so oversize captions fail fast without a network round-trip. */
export async function sendVideo(
  botToken: string,
  params: SendVideoParams,
  fetchImpl: FetchImpl = fetch,
): Promise<TelegramMessage> {
  if (!params.chat_id) {
    throw new TelegramApiError("missing_chat_id", "chat_id is required", { retryable: false });
  }
  if (!params.video || !/^https:\/\//.test(params.video)) {
    throw new TelegramApiError("missing_video_url", "video must be a public https URL", {
      retryable: false,
    });
  }
  if (params.caption !== undefined && params.caption.length > TELEGRAM_CAPTION_LIMIT) {
    throw new TelegramApiError(
      "caption_too_long",
      `caption is ${params.caption.length} chars; Telegram allows at most ${TELEGRAM_CAPTION_LIMIT}`,
      { retryable: false },
    );
  }
  return callMethod<TelegramMessage>(botToken, "sendVideo", params, fetchImpl);
}

/** Backwards-compatible alias used by the T3 stub signature. */
export const sendVideoUrl = sendVideo;

/** Resolve a chat so operators can verify a pasted chat_id (and bot admin
 * rights) before anything is scheduled. Throws TelegramApiError on failure. */
export async function getChat(
  botToken: string,
  chatId: string,
  fetchImpl: FetchImpl = fetch,
): Promise<TelegramChat> {
  if (!chatId) {
    throw new TelegramApiError("missing_chat_id", "chat_id is required", { retryable: false });
  }
  return callMethod<TelegramChat>(botToken, "getChat", { chat_id: chatId }, fetchImpl);
}
