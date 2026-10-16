/** R2 access via the S3-compatible endpoint (presigned browser uploads).
 *
 * The Worker never proxies video bytes: the browser PUTs straight to R2 with
 * a presigned URL, exactly like the sau-media API mints presigned PUTs. The
 * MEDIA binding (wrangler.toml) is used separately to HEAD/verify objects at
 * registration time.
 */

import { AwsClient } from "aws4fetch";

export interface R2Credentials {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** How long a minted upload URL stays usable. Must match the `X-Amz-Expires`
 * value actually signed into the URL (verified against the installed
 * aws4fetch source in tests/r2.test.ts). */
export const PRESIGNED_PUT_TTL_SECONDS = 3600;

export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

export function r2ObjectUrl(creds: R2Credentials, key: string): string {
  return `${r2Endpoint(creds.accountId)}/${creds.bucket}/${key}`;
}

function assertConfigured(creds: R2Credentials): void {
  if (!creds.accountId || !creds.bucket || !creds.accessKeyId || !creds.secretAccessKey) {
    throw new Error(
      "R2 is not configured: set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY",
    );
  }
}

/** Mint a presigned PUT URL for one upload. Offline signing; no network. */
export async function presignedPutUrl(
  creds: R2Credentials,
  key: string,
  contentType: string,
): Promise<{ url: string; expiresSeconds: number }> {
  assertConfigured(creds);
  const client = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  // The caller must send the exact same Content-Type header or R2 rejects
  // the PUT with SignatureDoesNotMatch (same constraint as sau-media).
  // Pin the expiry into the URL before signing: aws4fetch otherwise defaults
  // X-Amz-Expires to 86400 and the reported TTL would be a lie.
  const unsigned = new URL(r2ObjectUrl(creds, key));
  unsigned.searchParams.set("X-Amz-Expires", String(PRESIGNED_PUT_TTL_SECONDS));
  const signed = await client.sign(unsigned.toString(), {
    method: "PUT",
    headers: { "Content-Type": contentType },
    aws: { signQuery: true },
  });
  return { url: signed.url, expiresSeconds: PRESIGNED_PUT_TTL_SECONDS };
}
