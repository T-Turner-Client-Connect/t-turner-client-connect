import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Backup-layer encryption. Every object written to the backup bucket is sealed with AES-256-GCM
 * under BACKUP_ENCRYPTION_KEY — a separate key from APP_ENCRYPTION_KEY, kept only in Netlify's
 * environment and the owner's offline escrow, never in the bucket. Documents are therefore
 * encrypted twice: the app key inside (as stored), the backup key outside.
 *
 * Format: "TCB1" + keyId(4) + iv(12) + tag(16) + ciphertext.
 */
const MAGIC = Buffer.from("TCB1");
export const BACKUP_OVERHEAD_BYTES = 36;

function backupRaw(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.BACKUP_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) throw new Error("BACKUP_ENCRYPTION_KEY must be set (32+ random characters).");
  if (env.APP_ENCRYPTION_KEY && raw === env.APP_ENCRYPTION_KEY) throw new Error("BACKUP_ENCRYPTION_KEY must be different from APP_ENCRYPTION_KEY.");
  return raw;
}

const derive = (raw: string) => createHash("sha256").update(`backup:${raw}`).digest();
const kidOf = (raw: string) => createHash("sha256").update(`backup-kid:${raw}`).digest().subarray(0, 4);

/** Non-secret fingerprint of the backup key, written into each manifest. */
export function backupKeyId(env: NodeJS.ProcessEnv = process.env): string {
  return `b${kidOf(backupRaw(env)).toString("hex")}`;
}

export function sealBackup(plain: Uint8Array, env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const raw = backupRaw(env);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", derive(raw), iv);
  const data = Buffer.concat([c.update(plain), c.final()]);
  return new Uint8Array(Buffer.concat([MAGIC, kidOf(raw), iv, c.getAuthTag(), data]));
}

export function openBackup(sealed: Uint8Array, env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const buf = Buffer.from(sealed);
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error("Not a backup object (unknown format).");
  const raw = backupRaw(env);
  if (!buf.subarray(4, 8).equals(kidOf(raw))) throw new Error("This backup was sealed with a different BACKUP_ENCRYPTION_KEY.");
  const d = createDecipheriv("aes-256-gcm", derive(raw), buf.subarray(8, 20));
  d.setAuthTag(buf.subarray(20, 36));
  return new Uint8Array(Buffer.concat([d.update(buf.subarray(36)), d.final()]));
}

export const sha256Hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
