/**
 * The file encryption job from the command line (the same job as Owner's Office → File encryption).
 * Never runs on deploy. See docs/backup-restore.md → "Encrypting existing files".
 *
 *   npm run files:encrypt                         dry run: counts and bytes by record type (default)
 *   npm run files:encrypt -- --run --yes          run batches until done (or --batches N)
 *        [--mode ENCRYPT|REKEY] [--order BANK_STATEMENTS,NONPROFIT,...] [--limit 50]
 *   npm run files:encrypt -- --status             progress and failures
 *
 * Originals are never removed by this script; removal is a separate owner-only action on the page,
 * allowed only 30+ days after a file moved AND once a successful backup holds the encrypted copy.
 */
import { encryptionDryRun, encryptionStatus, runEncryptionBatch, startEncryptionJob, type EncryptionMode } from "@/lib/services/file-encryption";
import { GROUP_LABEL } from "@/lib/doc-security/inventory";

const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const opt = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const say = (s: string) => process.stdout.write(`${s}\n`);
const mb = (n: number | bigint) => `${(Number(n) / 1048576).toFixed(2)} MB`;

async function main() {
  const op = { cli: "scripts/encrypt-files.ts" };
  const mode = (opt("mode") === "REKEY" ? "REKEY" : "ENCRYPT") as EncryptionMode;
  const order = opt("order")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;

  if (flag("status")) {
    const s = await encryptionStatus();
    say(`Encrypted ${s.encrypted}, plaintext ${s.plaintext}, originals kept ${s.pendingOriginals} (${s.eligibleOriginals} eligible for removal).`);
    for (const j of s.jobs.slice(0, 3)) say(`Job ${j.id} ${j.mode} ${j.status}: ${j.doneFiles}/${j.totalFiles} moved, ${j.failedFiles} failing, ${j.batches} batches.`);
    for (const f of s.failures.slice(0, 20)) say(`  failed: ${f.sourceType} ${f.sourceId} (${f.attempts}×) ${f.lastError}`);
    return;
  }

  const dry = await encryptionDryRun(op, mode, order);
  say(`${mode === "REKEY" ? "Re-encrypt" : "Encrypt"} — dry run: ${dry.files} file(s), ${mb(dry.bytes)}${dry.unknownSize ? ` (+${dry.unknownSize} without a recorded size)` : ""}. Already encrypted: ${dry.alreadyEncrypted} of ${dry.totalFiles}.`);
  for (const g of dry.groups) say(`  ${GROUP_LABEL[g.group].padEnd(40)} ${String(g.files).padStart(6)} files  ${mb(g.bytes).padStart(12)}`);
  if (!flag("run")) return say("\nNothing was changed. Add --run --yes to start.");
  if (!flag("yes")) return say("\nAdd --yes to confirm the run.");

  await startEncryptionJob(op, mode, order);
  const max = Number(opt("batches") ?? 10_000);
  for (let i = 0; i < max; i++) {
    const r = await runEncryptionBatch(op, { limit: Number(opt("limit") ?? 50), budgetMs: 60_000 });
    say(`Batch ${i + 1}: moved ${r.migrated}, failed ${r.failed}, remaining ${r.remaining}.`);
    if (r.remaining === 0 || r.processed === 0) break;
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`✖ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
