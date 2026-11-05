import { createHash } from "node:crypto";

/**
 * Where backups go: any S3-compatible bucket (AWS S3, Backblaze B2, Cloudflare R2), configured
 * only through environment variables. Tests (and nothing else) swap in the in-memory target.
 *
 * Object Lock: each object is written with a retain-until date in GOVERNANCE or COMPLIANCE mode
 * (BACKUP_OBJECT_LOCK_MODE; OFF only for providers without per-object locks). Until that date the
 * provider refuses to delete or overwrite the object version — even with the app's own
 * credentials — which is what protects the backups from ransomware and accidents.
 */
export type LockMode = "GOVERNANCE" | "COMPLIANCE" | "OFF";

export type PutOptions = { lockUntil?: Date | null; contentType?: string };

export interface BackupTarget {
  readonly name: string;
  put(key: string, body: Uint8Array, opts?: PutOptions): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  /** Deletes an object. Throws LockedObjectError while a lock holds it. */
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  /** Extends an object's lock (locks can only be lengthened). No-op when locks are off. */
  extendLock(key: string, until: Date): Promise<void>;
}

export class LockedObjectError extends Error {
  constructor(key: string, until?: Date | null) {
    super(`Backup object is locked${until ? ` until ${until.toISOString().slice(0, 10)}` : ""} and can't be deleted yet (${key}).`);
    this.name = "LockedObjectError";
  }
}

export function lockModeFromEnv(env: NodeJS.ProcessEnv = process.env): LockMode {
  const v = (env.BACKUP_OBJECT_LOCK_MODE ?? "GOVERNANCE").trim().toUpperCase();
  return v === "COMPLIANCE" ? "COMPLIANCE" : v === "OFF" ? "OFF" : "GOVERNANCE";
}

export const BACKUP_ENV = ["BACKUP_S3_ENDPOINT", "BACKUP_S3_REGION", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY", "BACKUP_ENCRYPTION_KEY"] as const;

export function backupEnvComplete(env: NodeJS.ProcessEnv = process.env): boolean {
  return BACKUP_ENV.every((k) => !!env[k]?.trim());
}

/** In-memory bucket with Object Lock semantics (tests and local drills only). */
export class MemoryTarget implements BackupTarget {
  readonly name = "memory";
  objects = new Map<string, { body: Uint8Array; lockUntil: Date | null }>();
  constructor(private mode: LockMode = "GOVERNANCE", private now: () => Date = () => new Date()) {}
  async put(key: string, body: Uint8Array, opts: PutOptions = {}) {
    const existing = this.objects.get(key);
    // A locked object version can't be overwritten.
    if (existing?.lockUntil && existing.lockUntil > this.now()) throw new LockedObjectError(key, existing.lockUntil);
    this.objects.set(key, { body: new Uint8Array(body), lockUntil: this.mode === "OFF" ? null : opts.lockUntil ?? null });
  }
  async get(key: string) {
    const o = this.objects.get(key);
    return o ? new Uint8Array(o.body) : null;
  }
  async delete(key: string) {
    const o = this.objects.get(key);
    if (o?.lockUntil && o.lockUntil > this.now()) throw new LockedObjectError(key, o.lockUntil);
    this.objects.delete(key);
  }
  async list(prefix: string) {
    return [...this.objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.body.length })).sort((a, b) => (a.key < b.key ? -1 : 1));
  }
  async extendLock(key: string, until: Date) {
    const o = this.objects.get(key);
    if (!o || this.mode === "OFF") return;
    if (!o.lockUntil || until > o.lockUntil) o.lockUntil = until;
  }
}

/** S3-compatible target (AWS S3, Backblaze B2, Cloudflare R2). */
export class S3Target implements BackupTarget {
  readonly name: string;
  private clientP: Promise<import("@aws-sdk/client-s3").S3Client>;
  private bucket: string;
  private mode: LockMode;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    if (!backupEnvComplete(env)) throw new Error("Backup storage isn't configured (BACKUP_S3_* settings).");
    this.bucket = env.BACKUP_S3_BUCKET!.trim();
    this.mode = lockModeFromEnv(env);
    const endpoint = env.BACKUP_S3_ENDPOINT!.trim();
    this.name = `S3-compatible bucket at ${new URL(endpoint).host}`;
    this.clientP = import("@aws-sdk/client-s3").then(
      ({ S3Client }) =>
        new S3Client({
          endpoint,
          region: env.BACKUP_S3_REGION!.trim(),
          forcePathStyle: true,
          credentials: { accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID!.trim(), secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY!.trim() },
          // B2 and R2 don't accept every newer default checksum; Content-MD5 is sent explicitly instead.
          requestChecksumCalculation: "WHEN_REQUIRED",
          responseChecksumValidation: "WHEN_REQUIRED",
        }),
    );
  }
  async put(key: string, body: Uint8Array, opts: PutOptions = {}) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const md5 = createHash("md5").update(body).digest("base64");
    const lock = this.mode !== "OFF" && opts.lockUntil ? { ObjectLockMode: this.mode, ObjectLockRetainUntilDate: opts.lockUntil } : {};
    await (await this.clientP).send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentMD5: md5, ContentType: opts.contentType ?? "application/octet-stream", ...lock }));
  }
  async get(key: string) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    try {
      const r = await (await this.clientP).send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return r.Body ? new Uint8Array(await r.Body.transformToByteArray()) : null;
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchKey") return null;
      throw err;
    }
  }
  async delete(key: string) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    try {
      await (await this.clientP).send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      const name = (err as { name?: string }).name ?? "";
      if (name === "AccessDenied" || name === "InvalidRequest" || /lock|retention/i.test(String((err as Error).message))) throw new LockedObjectError(key);
      throw err;
    }
  }
  async list(prefix: string) {
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const out: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const r = await (await this.clientP).send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: Number(o.Size ?? 0) });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
  async extendLock(key: string, until: Date) {
    if (this.mode === "OFF") return;
    const { PutObjectRetentionCommand } = await import("@aws-sdk/client-s3");
    await (await this.clientP).send(new PutObjectRetentionCommand({ Bucket: this.bucket, Key: key, Retention: { Mode: this.mode, RetainUntilDate: until } }));
  }
}

let override: BackupTarget | null = null;

/** Tests only: route backups to an in-memory target. */
export function setBackupTargetForTests(t: BackupTarget | null) {
  override = t;
}

export function backupTarget(env: NodeJS.ProcessEnv = process.env): BackupTarget {
  return override ?? new S3Target(env);
}

/** Command-line drills: send backups to a local folder instead of the bucket. */
export const setBackupTargetOverride = setBackupTargetForTests;

export function hasTargetOverride() {
  return !!override;
}
