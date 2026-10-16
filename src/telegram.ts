/** Telegram Bot API transport. STUB for T3.
 *
 * Will mirror the sau-media adapter split: this module = transport
 * (sendVideo via URL/multipart, `_unwrap` of the `ok:false` envelope, 429 /
 * `retry_after` → retryable, 401/403 → auth failure). The publish flow
 * (channel resolution, caption assembly, result mapping) lands alongside it.
 */

export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Media captions are 0-1024 chars after entities parsing. There is no title
 * field; the title line renders inside the caption template instead. */
export const TELEGRAM_CAPTION_LIMIT = 1024;

export function sendVideoUrl(): Promise<never> {
  return Promise.reject(new Error("not implemented: T3 telegram client"));
}
