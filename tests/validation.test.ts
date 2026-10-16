import { describe, expect, it } from "vitest";
import {
  ALLOWED_CONTENT_TYPE,
  MAX_VIDEO_BYTES,
  UploadValidationError,
  assertStoredSizeOk,
  validateUploadIntent,
} from "../src/validation";

describe("upload intent validation", () => {
  it("accepts a well-formed mp4 intent and mints a key under sources/", () => {
    const key = validateUploadIntent({
      filename: "part_3.mp4",
      contentType: ALLOWED_CONTENT_TYPE,
      sizeBytes: 10 * 1024 * 1024,
    });
    expect(key.startsWith("sources/")).toBe(true);
    expect(key.endsWith(".mp4")).toBe(true);
  });

  it("accepts an intent without a declared size (checked at registration)", () => {
    const key = validateUploadIntent({ filename: "clip.MP4", contentType: "video/mp4" });
    expect(key.endsWith(".mp4")).toBe(true);
  });

  it("rejects non-mp4 filenames", () => {
    expect(() =>
      validateUploadIntent({ filename: "clip.mov", contentType: ALLOWED_CONTENT_TYPE }),
    ).toThrowError(UploadValidationError);
  });

  it("rejects wrong content types", () => {
    expect(() =>
      validateUploadIntent({ filename: "clip.mp4", contentType: "video/quicktime" }),
    ).toThrowError(UploadValidationError);
  });

  it("rejects declared sizes over the 50 MB Bot API cap", () => {
    try {
      validateUploadIntent({
        filename: "clip.mp4",
        contentType: ALLOWED_CONTENT_TYPE,
        sizeBytes: MAX_VIDEO_BYTES + 1,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UploadValidationError);
      expect((err as UploadValidationError).code).toBe("video_too_large");
    }
  });
});

describe("stored size check", () => {
  it("accepts exactly the cap", () => {
    expect(() => assertStoredSizeOk(MAX_VIDEO_BYTES)).not.toThrow();
  });

  it("rejects oversized stored objects", () => {
    expect(() => assertStoredSizeOk(MAX_VIDEO_BYTES + 1)).toThrowError(UploadValidationError);
  });

  it("rejects empty objects", () => {
    expect(() => assertStoredSizeOk(0)).toThrowError(UploadValidationError);
  });
});
