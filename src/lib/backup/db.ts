import { readdirSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { sha256Hex } from "./crypto";

/**
 * Logical export/import of the database: every application table (all Prisma models), read as
 * JSON rows in primary-key order and written as NDJSON. Import uses json_populate_recordset, so
 * every column type (enums, arrays, JSON, dates, BigInt, bytes) comes back exactly.
 * Migration bookkeeping tables (_prisma_migrations, _local_migrations…) are left out. Prisma's
 * implicit many-to-many tables also start with "_" (e.g. _MessageAttachments) and ARE included.
 */

export async function listTables(db: PrismaClient): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT (tablename LIKE '\\_%' AND tablename ILIKE '%migration%') ORDER BY tablename`);
  return rows.map((r) => r.tablename);
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

async function primaryKey(db: PrismaClient, table: string): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ attname: string }[]>(
    `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`,
    `public.${q(table)}`,
  );
  return rows.map((r) => r.attname);
}

/** One page of a table as NDJSON lines. */
export async function readChunk(db: PrismaClient, table: string, offset: number, limit: number): Promise<string[]> {
  const pk = await primaryKey(db, table);
  const order = pk.length ? pk.map((c) => `t.${q(c)}`).join(", ") : "t.ctid";
  const rows = await db.$queryRawUnsafe<{ j: string }[]>(`SELECT row_to_json(t)::text AS j FROM public.${q(table)} t ORDER BY ${order} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`);
  return rows.map((r) => r.j);
}

export async function countRows(db: PrismaClient, table: string): Promise<number> {
  const r = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM public.${q(table)}`);
  return Number(r[0].n);
}

/** A fingerprint of the schema (tables, columns, types). Restores refuse a target whose schema differs. */
export async function schemaFingerprint(db: PrismaClient): Promise<string> {
  const rows = await db.$queryRawUnsafe<{ t: string; c: string; ty: string }[]>(
    `SELECT table_name AS t, column_name AS c, udt_name AS ty FROM information_schema.columns WHERE table_schema = 'public' AND NOT (table_name LIKE '\\_%' AND table_name ILIKE '%migration%') ORDER BY 1, 2`,
  );
  return sha256Hex(rows.map((r) => `${r.t}.${r.c}:${r.ty}`).join("\n"));
}

/** The newest migration in netlify/database/migrations (bundled with the backup route), or null. */
export function lastMigrationName(root = process.cwd()): string | null {
  try {
    return readdirSync(path.join(root, "netlify", "database", "migrations")).filter((n) => /^\d{8,}/.test(n)).sort().at(-1) ?? null;
  } catch {
    return null;
  }
}

/**
 * Tables that hold the firm's and clients' records. A restore target must have none of these rows.
 * (A freshly migrated database already holds a few reference rows the migrations insert — default
 * settings and templates. Those are not records; the restore replaces them with the backup's.)
 */
export const CORE_TABLES = ["User", "Client", "PortalUser", "Document", "StoredFile", "AuditLog", "Contact", "Invoice", "JournalEntry"];

/** Whether the target holds no records (a full restore needs that), and which tables hold reference rows only. */
export async function databaseIsEmpty(db: PrismaClient): Promise<{ empty: boolean; nonEmpty: string[]; prefilled: string[] }> {
  const nonEmpty: string[] = [];
  const prefilled: string[] = [];
  for (const t of await listTables(db)) {
    const r = await db.$queryRawUnsafe<{ x: number }[]>(`SELECT 1 AS x FROM public.${q(t)} LIMIT 1`);
    if (!r.length) continue;
    if (CORE_TABLES.includes(t)) nonEmpty.push(t);
    else prefilled.push(t);
  }
  return { empty: nonEmpty.length === 0, nonEmpty, prefilled };
}

/**
 * Loads rows into the target. Foreign keys are checked as usual; tables are loaded in passes so
 * a child table waits for its parent (rows that reference rows in the same table load together).
 */
export async function loadTables(db: PrismaClient, data: { table: string; lines: string[] }[], replaceRows: Set<string> = new Set()): Promise<void> {
  const conflict = new Map<string, string>();
  for (const t of replaceRows) conflict.set(t, await upsertClause(db, t));
  // Fast path: with permission to defer triggers (superuser / owner), load everything in one transaction.
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
        for (const d of data) await insertLines(tx as unknown as PrismaClient, d.table, d.lines, conflict.get(d.table));
      },
      { timeout: 600_000, maxWait: 30_000 },
    );
    return;
  } catch (err) {
    if (!/permission denied|must be superuser|session_replication_role/i.test(String((err as Error).message))) throw err;
  }
  // Without that permission: passes in dependency order, one table per transaction.
  let pending = data.filter((d) => d.lines.length);
  for (let pass = 0; pending.length && pass < 50; pass++) {
    const next: typeof pending = [];
    for (const d of pending) {
      try {
        await db.$transaction(async (tx) => insertLines(tx as unknown as PrismaClient, d.table, d.lines, conflict.get(d.table)), { timeout: 600_000 });
      } catch (err) {
        if (!/foreign key/i.test(String((err as Error).message))) throw err;
        next.push(d);
      }
    }
    if (next.length === pending.length) throw new Error(`Couldn't load ${next.map((n) => n.table).join(", ")}: foreign keys can't be satisfied.`);
    pending = next;
  }
}

/** For a table the migrations pre-filled: the backup's row replaces the default row with the same key. */
async function upsertClause(db: PrismaClient, table: string): Promise<string> {
  const pk = await primaryKey(db, table);
  if (!pk.length) return "ON CONFLICT DO NOTHING";
  const cols = (await db.$queryRawUnsafe<{ c: string }[]>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, table)).map((r) => r.c).filter((c) => !pk.includes(c));
  return cols.length ? `ON CONFLICT (${pk.map(q).join(", ")}) DO UPDATE SET ${cols.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(", ")}` : "ON CONFLICT DO NOTHING";
}

async function insertLines(db: PrismaClient, table: string, lines: string[], onConflict = "") {
  for (let i = 0; i < lines.length; i += 500) {
    const json = `[${lines.slice(i, i + 500).join(",")}]`;
    await db.$executeRawUnsafe(`INSERT INTO public.${q(table)} SELECT * FROM json_populate_recordset(NULL::public.${q(table)}, $1::json) ${onConflict}`, json);
  }
}
