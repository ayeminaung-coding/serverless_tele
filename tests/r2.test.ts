import { describe, expect, it } from "vitest";
import { PRESIGNED_PUT_TTL_SECONDS, presignedPutUrl, r2Endpoint } from "../src/r2";

const CREDS = {
  accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  bucket: "telegram-serverless-media",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
};

describe("presigned PUT (offline signing)", () => {
  it("builds the R2 S3-compatible endpoint from the account id", () => {
    expect(r2Endpoint(CREDS.accountId)).toBe(
      "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com",
    );
  });

  it("signs a query-auth URL carrying the key, signature, and expiry", async () => {
    const { url, expiresSeconds } = await presignedPutUrl(CREDS, "sources/abc.mp4", "video/mp4");
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/telegram-serverless-media/sources/abc.mp4");
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    // The reported TTL must equal the X-Amz-Expires actually signed in.
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe(String(expiresSeconds));
    expect(expiresSeconds).toBe(PRESIGNED_PUT_TTL_SECONDS);
  });

  it("refuses to sign when credentials are missing", async () => {
    await expect(
      presignedPutUrl({ ...CREDS, secretAccessKey: "" }, "sources/abc.mp4", "video/mp4"),
    ).rejects.toThrowError(/R2 is not configured/);
  });
});
