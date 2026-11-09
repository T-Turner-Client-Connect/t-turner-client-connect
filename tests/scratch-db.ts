import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

/**
 * A separate, empty, fully migrated database next to the test database, for restore tests
 * (verify mode restores only into a scratch database, never the source).
 */
export function scratchUrl() {
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = `/${u.pathname.slice(1)}_scratch`;
  return u.toString();
}

export async function createScratchDb(): Promise<PrismaClient> {
  const url = new URL(scratchUrl());
  const name = url.pathname.replace(/^\//, "");
  if (!/^[a-z0-9_]+$/i.test(name) || !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) throw new Error("Scratch database must be local.");
  const admin = new URL(process.env.DATABASE_URL!);
  admin.pathname = "/postgres";
  const a = new PrismaClient({ datasourceUrl: admin.toString() });
  await a.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await a.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  await a.$disconnect();
  // All migrations in one file, applied the way scripts/migrate-local.mjs applies them.
  const dir = path.resolve(import.meta.dirname, "../netlify/database/migrations");
  const sql = readdirSync(dir)
    .sort()
    .map((n) => (n.endsWith(".sql") ? path.join(dir, n) : path.join(dir, n, "migration.sql")))
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n;\n");
  const tmp = path.join(mkdtempSync(path.join(tmpdir(), "scratch-")), "all.sql");
  writeFileSync(tmp, sql);
  execFileSync("npx", ["prisma", "db", "execute", "--url", url.toString(), "--file", tmp], { stdio: "pipe" });
  return new PrismaClient({ datasourceUrl: url.toString() });
}

export async function wipe(db: PrismaClient) {
  const tables = await db.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT (tablename LIKE '\\_%' AND tablename ILIKE '%migration%')`;
  if (tables.length) await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
}
