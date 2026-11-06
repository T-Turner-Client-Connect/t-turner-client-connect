import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Secrets at rest (MFA seeds) and client files are encrypted with AES-256-GCM
 * using keys derived from APP_ENCRYPTION_KEY. Signed, expiring download links
 * use an HMAC derived from the same key.
 *
 * Key rotation: set the new value as APP_ENCRYPTION_KEY and move the old one to
 * APP_ENCRYPTION_KEY_PREVIOUS. Everything still decrypts (the previous key is
 * tried when the current one doesn't match), new writes use the new key, and
 * the owner's re-encrypt job (Owner's Office → File encryption) moves old files
 * to the new key. See docs/backup-restore.md → "Key rotation".
 */
type KeySlot = "current" | "previous";

function rawKey(slot: KeySlot): string | null {
  const raw = slot === "current" ? process.env.APP_ENCRYPTION_KEY : process.env.APP_ENCRYPTION_KEY_PREVIOUS;
  if (!raw) {
    if (slot === "current") throw new Error("APP_ENCRYPTION_KEY must be set (32+ random characters).");
    return null;
  }
  if (raw.length < 32) throw new Error(`${slot === "current" ? "APP_ENCRYPTION_KEY" : "APP_ENCRYPTION_KEY_PREVIOUS"} must be 32+ random characters.`);
  return raw;
}

function derive(raw: string, purpose: string): Buffer {
  return createHash("sha256").update(`${purpose}:${raw}`).digest();
}

function key(purpose: string, slot: KeySlot = "current"): Buffer | null {
  const raw = rawKey(slot);
  return raw ? derive(raw, purpose) : null;
}

const currentKey = (purpose: string) => key(purpose, "current")!;

/** A short, non-secret fingerprint of a key (4 bytes), written into each encrypted file so the right key is chosen. */
function keyId(raw: string): Buffer {
  return createHash("sha256").update(`kid:${raw}`).digest().subarray(0, 4);
}

/** The key version new files are written with ("k" + 8 hex characters). Never reveals the key. */
export function currentFileKeyVersion(): string {
  return `k${keyId(rawKey("current")!).toString("hex")}`;
}

/** Whether a previous key is configured (for the settings checklist; never the value). */
export function previousKeyConfigured(): boolean {
  return !!process.env.APP_ENCRYPTION_KEY_PREVIOUS;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", currentKey("enc"), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptSecret(token: string): string {
  const [v, iv, tag, data] = token.split(".");
  if (v !== "v1") throw new Error("Unknown secret format");
  const attempt = (k: Buffer) => {
    const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  };
  try {
    return attempt(currentKey("enc"));
  } catch (err) {
    const prev = key("enc", "previous");
    if (!prev) throw err;
    return attempt(prev);
  }
}

/**
 * File bytes.
 *  - "TCE2" + keyId(4) + iv(12) + tag(16) + ciphertext — written now (36 bytes of overhead per file).
 *  - "TCE1" + iv(12) + tag(16) + ciphertext — older identity documents (no key id; both keys are tried).
 */
const FILE_MAGIC_V1 = Buffer.from("TCE1");
const FILE_MAGIC_V2 = Buffer.from("TCE2");
export const FILE_ENCRYPTION_OVERHEAD_BYTES = 36;

export function encryptBytes(plain: Uint8Array): Uint8Array {
  const raw = rawKey("current")!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(raw, "file"), iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return new Uint8Array(Buffer.concat([FILE_MAGIC_V2, keyId(raw), iv, cipher.getAuthTag(), data]));
}

/** True when the bytes carry the app's encrypted-file header. */
export function looksEncrypted(stored: Uint8Array): boolean {
  if (stored.length < 32) return false;
  const head = Buffer.from(stored.subarray(0, 4));
  return head.equals(FILE_MAGIC_V1) || head.equals(FILE_MAGIC_V2);
}

/** The key version an encrypted file was written with, or null for the older format / plaintext. */
export function fileKeyVersionOf(stored: Uint8Array): string | null {
  const buf = Buffer.from(stored);
  if (!buf.subarray(0, 4).equals(FILE_MAGIC_V2)) return null;
  return `k${buf.subarray(4, 8).toString("hex")}`;
}

function gcmOpen(k: Buffer, iv: Buffer, tag: Buffer, data: Buffer): Uint8Array {
  const decipher = createDecipheriv("aes-256-gcm", k, iv);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(data), decipher.final()]));
}

export function decryptBytes(stored: Uint8Array): Uint8Array {
  const buf = Buffer.from(stored);
  const magic = buf.subarray(0, 4);
  const slots: KeySlot[] = ["current", "previous"];
  if (magic.equals(FILE_MAGIC_V2)) {
    const kid = buf.subarray(4, 8);
    for (const s of slots) {
      const raw = rawKey(s);
      if (raw && keyId(raw).equals(kid)) return gcmOpen(derive(raw, "file"), buf.subarray(8, 20), buf.subarray(20, 36), buf.subarray(36));
    }
    throw new Error("This file was encrypted with a key that isn't configured (check APP_ENCRYPTION_KEY and APP_ENCRYPTION_KEY_PREVIOUS).");
  }
  if (magic.equals(FILE_MAGIC_V1)) {
    let lastErr: unknown = null;
    for (const s of slots) {
      const k = key("file", s);
      if (!k) continue;
      try {
        return gcmOpen(k, buf.subarray(4, 16), buf.subarray(16, 32), buf.subarray(32));
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error("Couldn't decrypt the file.");
  }
  throw new Error("Unknown file format");
}

/** Bytes as stored → original bytes: decrypts the app's format, passes older plaintext files through. */
export function openStoredBytes(stored: Uint8Array): Uint8Array {
  return looksEncrypted(stored) ? decryptBytes(stored) : stored;
}

export function sign(payload: string): string {
  return createHmac("sha256", currentKey("sign")).update(payload).digest("base64url");
}

export function verifySignature(payload: string, signature: string): boolean {
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
