import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify the `X-CartonPilot-Signature` header of a webhook delivery.
 *
 * CartonPilot signs each delivery with `sha256=<hex HMAC-SHA256 of the raw
 * request body>` using the secret provided when the job was submitted.
 * Compute the comparison over the *raw* body bytes — do not re-serialize
 * parsed JSON. Uses a timing-safe comparison.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }
  const match = /^sha256=([0-9a-fA-F]+)$/.exec(signatureHeader.trim());
  if (!match) {
    return false;
  }
  const provided = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  // Length mismatch also catches odd-length hex silently truncated by Buffer.from.
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}
