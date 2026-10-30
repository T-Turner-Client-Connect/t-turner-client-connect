// Applies netlify/database/migrations to a LOCAL Postgres (development/tests).
// Hosted databases are migrated by Netlify on deploy — this script refuses to
// run on Netlify or against a non-local host.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL to your local database.");
if (process.env.CONTEXT || process.env.NETLIFY) throw new Error("Never run this on Netlify — Netlify applies migrations itself.");
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) throw new Error("Refusing to migrate a non-local database.");

const dir = "netlify/database/migrations";
const migrations = readdirSync(dir)
  .filter((n) => n.endsWith(".sql") || (statSync(join(dir, n)).isDirectory() && existsSync(join(dir, n, "migration.sql"))))
  .sort();

const run = (file) => execFileSync("npx", ["prisma", "db", "execute", "--url", url, "--file", file], { stdio: "inherit" });
const tmp = mkdtempSync(join(tmpdir(), "mig-"));
const sql = (text) => {
  const f = join(tmp, "q.sql");
  writeFileSync(f, text);
  run(f);
};

sql(`CREATE TABLE IF NOT EXISTS "_local_migrations" (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());`);
const prisma = new PrismaClient({ datasourceUrl: url });
const applied = new Set((await prisma.$queryRawUnsafe(`SELECT name FROM "_local_migrations"`)).map((r) => r.name));
await prisma.$disconnect();

// Mirror Netlify's rule: a pending migration must be newer than every applied one.
// (Netlify rejects an older one instead of skipping it, which blocks the deploy.)
const newestApplied = [...applied].sort().at(-1);
const outOfOrder = migrations.filter((n) => !applied.has(n) && newestApplied && n < newestApplied);
if (outOfOrder.length) {
  throw new Error(`Out-of-order migration(s): ${outOfOrder.join(", ")} — older than the newest applied (${newestApplied}). Netlify would reject this deploy. Give it a newer version prefix (never rename one that has already been applied).`);
}

let count = 0;
for (const name of migrations) {
  if (applied.has(name)) continue;
  const file = name.endsWith(".sql") ? join(dir, name) : join(dir, name, "migration.sql");
  console.log(`Applying ${name}`);
  run(file);
  sql(`INSERT INTO "_local_migrations" (name) VALUES ('${name.replace(/'/g, "''")}');`);
  count++;
}
console.log(count ? `Applied ${count} migration(s).` : "Local database is up to date.");
