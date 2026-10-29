import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a Resend webhook (Resend signs with Svix): HMAC-SHA256 over
 * "id.timestamp.body" with the endpoint's signing secret, rejecting
 * timestamps more than five minutes off to stop replays.
 */
export function verifyResendSignature(secret: string, headers: { id: string; timestamp: string; signature: string }, body: string, nowSeconds = Date.now() / 1000): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = Buffer.from(createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64"));
  return signature.split(" ").some((part) => {
    const [version, sig = ""] = part.split(",");
    const given = Buffer.from(sig);
    return version === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export function resendSignatureFor(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}
