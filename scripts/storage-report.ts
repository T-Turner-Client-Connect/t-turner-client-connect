/**
 * Storage & backup-cost report. LOCAL DATABASES ONLY — it refuses the production database and any
 * non-local host. Reads the database and the local file store; changes nothing.
 *
 *   DATABASE_URL=postgresql://…@localhost:5432/… npm run storage:report
 *        [-- --new-mb-per-day 50 --deleted-gb-per-year 2 --years 1]
 *
 * Prints: document count and bytes by record type, database size, the measured compression ratio
 * of the database export, the measured per-file encryption overhead, and projected backup storage
 * under the 35-day / 12-month / 7-year policy (formula in docs/backup-restore.md).
 */
import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { prisma } from "@/lib/prisma";
import { fileInventory, totalsByGroup } from "@/lib/doc-security/inventory";
import { listTables, readChunk } from "@/lib/backup/db";
import { isProductionDatabaseUrl } from "@/lib/backup/restore";
import { DB_COPIES, estimateBackupStorage, monthlyCost } from "@/lib/backup/estimate";
import { encryptBytes } from "@/lib/crypto";
import { sealBackup } from "@/lib/backup/crypto";

const argv = process.argv.slice(2);
const num = (k: string, d: number) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const say = (s = "") => process.stdout.write(`${s}\n`);
const gb = (n: number) => `${(n / 1e9).toFixed(3)} GB`;
const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`;

async function main() {
  const url = process.env.NETLIFY_DB_URL || process.env.DATABASE_URL || "";
  if (!url || process.env.NETLIFY || process.env.CONTEXT || isProductionDatabaseUrl(url)) throw new Error("storage-report runs only against a local database (never production).");

  const inv = await fileInventory();
  const docBytes = inv.reduce((n, i) => n + (i.sizeBytes ?? 0), 0);
  say("Documents and files by record type");
  for (const g of totalsByGroup(inv)) say(`  ${g.label.padEnd(40)} ${String(g.files).padStart(7)}  ${mb(g.bytes).padStart(12)}${g.unknownSize ? `  (+${g.unknownSize} unsized)` : ""}`);
  say(`  ${"Total".padEnd(40)} ${String(inv.length).padStart(7)}  ${mb(docBytes).padStart(12)}  (encrypted: ${inv.filter((i) => i.encrypted).length})`);

  const size = Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT pg_database_size(current_database())::bigint AS n`))[0].n);
  // Measure the compressed export the backup would write.
  let raw = 0, gz = 0;
  for (const t of await listTables(prisma)) {
    for (let off = 0; ; off += 5000) {
      const lines = await readChunk(prisma, t, off, 5000);
      if (!lines.length) break;
      const buf = Buffer.from(lines.join("\n") + "\n");
      raw += buf.length;
      gz += gzipSync(buf).length;
      if (lines.length < 5000) break;
    }
  }
  const ratio = size ? gz / size : 0;
  say();
  say(`Database: ${mb(size)} on disk (pg_database_size); export ${mb(raw)} NDJSON → ${mb(gz)} gzipped (ratio to on-disk size r = ${ratio.toFixed(3)})`);

  // Per-file encryption overhead, measured.
  const sample = new Uint8Array(1024 * 1024).map((_, i) => (i * 31) % 251);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) encryptBytes(sample);
  const msPerMb = (performance.now() - t0) / 20;
  const appOverhead = encryptBytes(new Uint8Array(1000)).length - 1000;
  const backupOverhead = sealBackup(new Uint8Array(1000)).length - 1000;
  say(`Encryption overhead per file: ${appOverhead} bytes (app layer) + ${backupOverhead} bytes (backup layer); ~${msPerMb.toFixed(2)} ms per MB to encrypt.`);

  const manifestPerFile = inv.length ? gzipSync(Buffer.from(JSON.stringify(inv.map((i) => ({ storageKey: i.storageKey, objectKey: `files/${"0".repeat(64)}.tcb`, sourceType: i.sourceType, sourceId: i.sourceId, group: i.group, storedSha256: "0".repeat(64), objectSha256: "0".repeat(64), plainSha256: "0".repeat(64), sizeBytes: i.sizeBytes ?? 0 }))))).length / inv.length : 120;
  // r·S is taken as the measured compressed export (on a nearly empty database, the on-disk size is mostly fixed overhead).
  const input = { documentBytes: docBytes, fileCount: inv.length, dbBytes: gz, dbCompressedRatio: 1, newDocumentBytesPerDay: num("new-mb-per-day", 50) * 1048576, deletedBytesPerYear: num("deleted-gb-per-year", 1) * 1e9, manifestBytesPerFile: manifestPerFile, yearsAhead: num("years", 0) };
  const e = estimateBackupStorage(input);
  say();
  say(`Projected backup storage (35 daily + 12 month-end + 7 year-end = ${DB_COPIES} database copies; documents stored once)`);
  say(`  database copies:  ${gb(e.database)}`);
  say(`  documents:        ${gb(e.documents)}   (today ${gb(docBytes)}, +${num("new-mb-per-day", 50)} MB/day × ${input.yearsAhead} yr, deleted ${num("deleted-gb-per-year", 1)} GB/yr kept)`);
  say(`  manifests:        ${gb(e.manifests)}   (${manifestPerFile.toFixed(0)} bytes per file per copy)`);
  say(`  overhead:         ${gb(e.overhead)}`);
  say(`  TOTAL:            ${gb(e.total)}`);
  say(`  monthly cost ≈ B2 $${monthlyCost(e.total, 0.006).toFixed(2)} · R2 $${monthlyCost(e.total, 0.015).toFixed(2)} · S3 Standard $${monthlyCost(e.total, 0.023).toFixed(2)} (storage only; check current provider prices)`);
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`✖ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
