/** Upload validation: Telegram-ready MP4s only, under the Bot API cap.
 *
 * There is no ffmpeg on Workers (free: 10ms CPU, 128MB), so the server does
 * not transcode. It enforces the contract instead: `.mp4` extension,
 * `video/mp4` content type, and the 50 MB cloud Bot API limit. Files must
 * arrive pre-encoded (H.264/AAC); anything else is rejected with a clear
 * error before a single byte is uploaded.
 */

export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export const ALLOWED_CONTENT_TYPE = "video/mp4";

export class UploadValidationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "UploadValidationError";
    this.code = code;
    this.status = status;
  }
}

export interface UploadIntent {
  filename: string;
  contentType: string;
  /** Declared size, when the client knows it. The authoritative check is the
   * R2 HEAD at registration time; this fails fast before minting a URL. */
  sizeBytes?: number;
}

/** Validate an upload intent and return the R2 key it should be PUT to. */
export function validateUploadIntent(intent: UploadIntent): string {
  const filename = (intent.filename ?? "").trim();
  if (!filename) {
    throw new UploadValidationError("missing_filename", "filename is required", 400);
  }
  if (!filename.toLowerCase().endsWith(".mp4")) {
    throw new UploadValidationError(
      "unsupported_container",
      "only .mp4 files are accepted; Telegram clients play MPEG4 video",
      415,
    );
  }
  if (intent.contentType !== ALLOWED_CONTENT_TYPE) {
    throw new UploadValidationError(
      "unsupported_content_type",
      `content_type must be ${ALLOWED_CONTENT_TYPE}`,
      415,
    );
  }
  if (
    intent.sizeBytes !== undefined &&
    (!Number.isFinite(intent.sizeBytes) || intent.sizeBytes <= 0)
  ) {
    throw new UploadValidationError("invalid_size", "size_bytes must be positive", 400);
  }
  if (intent.sizeBytes !== undefined && intent.sizeBytes > MAX_VIDEO_BYTES) {
    throw new UploadValidationError(
      "video_too_large",
      `video is ${intent.sizeBytes} bytes; the Telegram Bot API accepts at most ${MAX_VIDEO_BYTES}`,
      413,
    );
  }
  return `sources/${crypto.randomUUID()}.mp4`;
}

/** Authoritative size check against the stored object. Returns nothing; throws. */
export function assertStoredSizeOk(sizeBytes: number): void {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new UploadValidationError("invalid_stored_size", "stored object is empty", 400);
  }
  if (sizeBytes > MAX_VIDEO_BYTES) {
    throw new UploadValidationError(
      "video_too_large",
      `stored video is ${sizeBytes} bytes; the Telegram Bot API accepts at most ${MAX_VIDEO_BYTES}`,
      413,
    );
  }
}
