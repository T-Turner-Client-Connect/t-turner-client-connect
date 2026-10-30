import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Secrets at rest (MFA seeds) are encrypted with AES-256-GCM using
 * APP_ENCRYPTION_KEY. Signed, expiring download links use an HMAC derived
 * from the same key.
 */
function key(purpose: string): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) throw new Error("APP_ENCRYPTION_KEY must be set (32+ random characters).");
  return createHash("sha256").update(`${purpose}:${raw}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("enc"), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptSecret(token: string): string {
  const [v, iv, tag, data] = token.split(".");
  if (v !== "v1") throw new Error("Unknown secret format");
  const decipher = createDecipheriv("aes-256-gcm", key("enc"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** File bytes (identity documents): "TCE1" + iv(12) + tag(16) + ciphertext. */
const FILE_MAGIC = Buffer.from("TCE1");
export function encryptBytes(plain: Uint8Array): Uint8Array {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("file"), iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return new Uint8Array(Buffer.concat([FILE_MAGIC, iv, cipher.getAuthTag(), data]));
}

export function decryptBytes(stored: Uint8Array): Uint8Array {
  const buf = Buffer.from(stored);
  if (!buf.subarray(0, 4).equals(FILE_MAGIC)) throw new Error("Unknown file format");
  const decipher = createDecipheriv("aes-256-gcm", key("file"), buf.subarray(4, 16));
  decipher.setAuthTag(buf.subarray(16, 32));
  return new Uint8Array(Buffer.concat([decipher.update(buf.subarray(32)), decipher.final()]));
}

export function sign(payload: string): string {
  return createHmac("sha256", key("sign")).update(payload).digest("base64url");
}

export function verifySignature(payload: string, signature: string): boolean {
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
