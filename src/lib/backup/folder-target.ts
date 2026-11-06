import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { LockedObjectError, type BackupTarget, type LockMode, type PutOptions } from "./target";

/**
 * A folder that behaves like a bucket, with lock dates kept in a sidecar file. For command-line
 * drills only (scripts/backup-restore.ts --target-dir). The app itself always uses S3Target.
 */
export class FolderTarget implements BackupTarget {
  readonly name: string;
  constructor(private root: string, private mode: LockMode = "GOVERNANCE") {
    this.name = `folder ${root}`;
  }
  private file(key: string) {
    if (key.includes("..") || key.startsWith("/")) throw new Error("Invalid object key");
    return path.join(this.root, key);
  }
  private async lockOf(key: string): Promise<Date | null> {
    try {
      return new Date((await readFile(`${this.file(key)}.lock`, "utf8")).trim());
    } catch {
      return null;
    }
  }
  async put(key: string, body: Uint8Array, opts: PutOptions = {}) {
    const f = this.file(key);
    const lock = await this.lockOf(key);
    if (lock && lock > new Date()) throw new LockedObjectError(key, lock);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, body);
    if (this.mode !== "OFF" && opts.lockUntil) await writeFile(`${f}.lock`, opts.lockUntil.toISOString());
  }
  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.file(key)));
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    const lock = await this.lockOf(key);
    if (lock && lock > new Date()) throw new LockedObjectError(key, lock);
    const f = this.file(key);
    await rm(f, { force: true });
    await rm(`${f}.lock`, { force: true });
  }
  async list(prefix: string) {
    const out: { key: string; size: number }[] = [];
    const walk = async (dir: string) => {
      let entries: Dirent[] = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (!e.name.endsWith(".lock")) {
          const key = path.relative(this.root, full).split(path.sep).join("/");
          if (key.startsWith(prefix)) out.push({ key, size: (await stat(full)).size });
        }
      }
    };
    await walk(this.root);
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  }
  async extendLock(key: string, until: Date) {
    if (this.mode === "OFF") return;
    const lock = await this.lockOf(key);
    if (!lock || until > lock) await writeFile(`${this.file(key)}.lock`, until.toISOString());
  }
}
