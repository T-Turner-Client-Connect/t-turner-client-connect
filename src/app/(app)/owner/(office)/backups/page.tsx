import { notFound } from "next/navigation";
import clsx from "clsx";
import { DatabaseBackup, KeyRound, ShieldCheck, Stethoscope } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Notice, PageHeader, Stat } from "@/components/ui";
import { Check, fmtBytes, securityCard, StatusPill, Switch } from "@/components/owner/doc-security-bits";
import { requireOffice } from "@/lib/auth/owner";
import { backupOverview } from "@/lib/services/backups";
import { backupNowAction, keyEscrowAction, nightlyBackupsAction, restoreVerifyAction } from "@/app/actions/doc-security";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Backups" };

const btn = (primary = true) => clsx("inline-flex min-h-10 items-center rounded-lg px-4 py-2 text-sm font-semibold shadow", primary ? "bg-navy-900 text-white hover:bg-navy-800" : "border-[1.5px] border-navy-900 bg-white text-navy-900");

export default async function BackupsPage() {
  // Owner only (not a grantable permission).
  const { access } = await requireOffice();
  if (!access.isOwner) notFound();
  const o = await backupOverview();
  const s = o.settings;
  const lockMode = process.env.BACKUP_OBJECT_LOCK_MODE?.trim().toUpperCase() || "GOVERNANCE";

  return (
    <>
      <PageHeader title="Backups" subtitle="Independent, encrypted nightly copies of the database and every document, kept outside Netlify. Only you can turn them on, run a restore check, or change anything here." />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Last successful backup" value={o.lastSuccess?.finishedAt ? fmtDate(o.lastSuccess.finishedAt) : "None yet"} hint={o.lastSuccess ? `${Number(o.lastSuccess.rows).toLocaleString()} rows · ${o.lastSuccess.files.toLocaleString()} files` : "Turn on nightly backups below"} />
        <Stat label="Files in the backup bucket" value={o.filesInBucket.toLocaleString()} hint={`${fmtBytes(o.fileBytesInBucket)} (before backup encryption)`} />
        <Stat label="Last successful restore test" value={o.lastPassedTest ? fmtDate(o.lastPassedTest.startedAt) : "None yet"} hint={o.lastPassedTest ? `${o.lastPassedTest.mode === "FULL" ? "Full restore" : "Verify"} · ${o.lastPassedTest.source === "CLI" ? "command line" : "this page"}` : "Run one each quarter"} />
        <Stat label="Next restore test due" value={o.nextTestDue ? fmtDate(o.nextTestDue) : "Now"} hint="Every quarter; alert after 100 days" />
      </div>

      <div className="mb-5 space-y-3">
        {o.switchOn && o.staleBackup && <Notice tone="error" title="No successful backup in the last 48 hours">A high-priority task and an email (if email is set up) were sent. Check the run list below for the error.</Notice>}
        {o.testOverdue && o.lastSuccess && <Notice tone="warn" title="A restore test is due">The last passed restore test is more than 100 days old (or there isn&apos;t one). Run “Verify the latest backup” below.</Notice>}
        {!s.keysDiffer && s.rows.find((r) => r.name === "BACKUP_ENCRYPTION_KEY")?.set && <Notice tone="error">BACKUP_ENCRYPTION_KEY must be different from APP_ENCRYPTION_KEY. Backups refuse to run until it is.</Notice>}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className={securityCard} data-testid="backup-switch">
          <h2 className="flex items-center gap-3 font-serif text-xl font-bold text-navy-900"><DatabaseBackup className="size-7 text-gold-600" aria-hidden /> Nightly backups</h2>
          <p className="mt-1 text-sm text-navy-800">Every night around 2:00 AM Central: the whole database (every table) and any new or changed documents go to your own S3-compatible bucket (AWS S3, Backblaze B2 or Cloudflare R2). Everything is sealed with the backup key before it leaves; documents are encrypted twice.</p>
          <ul className="mt-4 space-y-1.5">
            <Check ok={s.ready}>All backup settings present in Netlify</Check>
            <Check ok={s.keysDiffer}>Backup key is separate from the app key</Check>
            <Check ok={lockMode !== "OFF"}>Object Lock on each backup object ({lockMode.toLowerCase()} mode)</Check>
            <Check ok={o.switchOn}>Turned on by you</Check>
          </ul>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-ivory-200 pt-4">
            <Switch on={o.switchOn} label="Nightly backups" testId="nightly-backups-state" />
            <div className="flex flex-wrap gap-2">
              <ActionForm action={nightlyBackupsAction.bind(null, !o.switchOn)} confirm={o.switchOn ? "Turn off nightly backups? Existing backups stay in the bucket." : "Turn on nightly backups? The first one copies everything, records that exist only in Client Connect first."}>
                <button type="submit" className={btn(!o.switchOn)} data-testid="toggle-nightly-backups">{o.switchOn ? "Turn off" : "Turn on"}</button>
              </ActionForm>
              {s.ready && (
                <ActionForm action={backupNowAction}>
                  <button type="submit" className={btn(false)}>Back up now</button>
                </ActionForm>
              )}
            </div>
          </div>
          {o.switchChangedAt && <p className="mt-2 text-xs text-slate-600">Last changed {fmtDateTime(o.switchChangedAt)}.</p>}
        </section>

        <section className={securityCard} data-testid="backup-settings">
          <h2 className="flex items-center gap-3 font-serif text-xl font-bold text-navy-900"><ShieldCheck className="size-7 text-gold-600" aria-hidden /> Settings checklist</h2>
          <p className="mt-1 text-sm text-navy-800">Which settings this site can see in Netlify. Values are never shown.</p>
          <ul className="mt-3 divide-y divide-ivory-200 text-sm">
            {s.rows.map((r) => (
              <li key={r.name} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-0.5 py-2">
                <span className="min-w-0 break-all font-mono text-[13px] text-navy-900">{r.name}</span>
                <span className={clsx("shrink-0 text-xs font-semibold", r.set ? "text-emerald-700" : "text-slate-500")}>{r.set ? "Set" : "Not set"}</span>
                <span className="w-full text-xs text-slate-600">{r.note}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className={clsx(securityCard, "mt-5")} data-testid="backup-runs">
        <h2 className="font-serif text-xl font-bold text-navy-900">Backup runs</h2>
        {o.runs.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No backups yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-600">
                <tr><th className="py-2 pr-3">Night</th><th className="pr-3">Started</th><th className="pr-3">Finished</th><th className="pr-3">Result</th><th className="pr-3 text-right">Rows</th><th className="pr-3 text-right">Files</th><th className="pr-3 text-right">Uploaded</th><th>Kept as</th></tr>
              </thead>
              <tbody className="divide-y divide-ivory-200">
                {o.runs.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="whitespace-nowrap py-2 pr-3 font-semibold text-navy-900">{r.backupDate}{r.trigger === "MANUAL" && <span className="ml-1 text-xs font-normal text-slate-600">(manual)</span>}</td>
                    <td className="pr-3">{fmtDateTime(r.startedAt)}</td>
                    <td className="pr-3">{r.finishedAt ? fmtDateTime(r.finishedAt) : "—"}</td>
                    <td className="pr-3"><StatusPill status={r.status} />{r.error && <p className="mt-1 max-w-xs text-xs text-red-800">{r.error}</p>}</td>
                    <td className="pr-3 text-right tabular-nums">{Number(r.rows).toLocaleString()}</td>
                    <td className="pr-3 text-right tabular-nums">{r.files.toLocaleString()} <span className="text-xs text-slate-600">({r.filesUploaded} new)</span></td>
                    <td className="pr-3 text-right tabular-nums">{fmtBytes(r.bytesUploaded)}</td>
                    <td className="text-xs">{r.retention === "PRUNED" ? "Pruned" : r.retention === "YEARLY" ? "Year-end (7 yrs)" : r.retention === "MONTHLY" ? "Month-end (12 mo)" : r.retention ? "Daily (35 days)" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-600">Kept: every night for 35 days, the last backup of each month for 12 months, the last of each year for 7 years. The newest successful backup is never removed, and nothing is removed before its lock date.</p>
      </section>

      <section className={clsx(securityCard, "mt-5")} data-testid="restore-tests">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-3 font-serif text-xl font-bold text-navy-900"><Stethoscope className="size-7 text-gold-600" aria-hidden /> Restore tests</h2>
          {o.lastSuccess && (
            <ActionForm action={restoreVerifyAction}>
              <button type="submit" className={btn()} data-testid="run-restore-verify">Verify the latest backup</button>
            </ActionForm>
          )}
        </div>
        <p className="mt-1 text-sm text-navy-800">A check downloads a backup, decrypts it, compares every database chunk and file with its fingerprint, restores into a scratch copy (never the live database) and opens sample documents, always including one from each record type that exists only in Client Connect. Each result is kept for the WISP.</p>
        {o.tests.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No restore tests yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-ivory-200 text-sm">
            {o.tests.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="font-semibold text-navy-900">{fmtDateTime(t.startedAt)}</span>
                <StatusPill status={t.status} />
                <span className="text-slate-700">{t.mode === "FULL" ? "Full restore" : "Verify"} · {t.source === "CLI" ? "command line" : "this page"} · backup {t.manifestKey.split("/")[1]?.split("_")[0] ?? "?"}</span>
                {t.error && <span className="w-full text-xs text-red-800">{t.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={clsx(securityCard, "mt-5")} data-testid="key-management">
        <h2 className="flex items-center gap-3 font-serif text-xl font-bold text-navy-900"><KeyRound className="size-7 text-gold-600" aria-hidden /> Keys</h2>
        <Notice tone="warn" title="Both keys are needed to restore">Restores need the backup key AND the app key (APP_ENCRYPTION_KEY): documents inside a backup are still encrypted with the app key. If the app key is lost, documents can&apos;t be recovered from any backup. Keep both keys only in Netlify and in your offline escrow, never in the bucket.</Notice>
        <div className="mt-4 grid gap-5 lg:grid-cols-2">
          <div>
            <h3 className="font-semibold text-navy-900">Offline escrow checklist</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-navy-900">
              <li>Two sealed copies of APP_ENCRYPTION_KEY and BACKUP_ENCRYPTION_KEY (printed, or in a password manager export).</li>
              <li>Held in two separate places (e.g. the office safe and a bank safe-deposit box).</li>
              <li>Each envelope dated and signed across the seal; neither copy kept with the bucket credentials.</li>
              <li>Re-done whenever a key is rotated; old envelopes destroyed once the rotation is complete.</li>
            </ul>
            <ActionForm action={keyEscrowAction} className="mt-3 space-y-2">
              <label className="flex items-start gap-2 text-sm text-navy-900"><input type="checkbox" name="confirmed" className="mt-1" /> I confirm both keys are held offline in two sealed copies stored separately.</label>
              <input name="note" className="input w-full" placeholder="Where (optional, no key values), e.g. office safe + bank box" maxLength={300} />
              <button type="submit" className={btn()}>Record confirmation</button>
            </ActionForm>
            <p className="mt-2 text-sm text-navy-900" data-testid="escrow-attestation">Key escrow confirmed on: <strong>{o.escrow.at ? fmtDate(o.escrow.at) : "not yet"}</strong>{o.escrow.note ? ` (${o.escrow.note})` : ""}</p>
          </div>
          <div>
            <h3 className="font-semibold text-navy-900">Rotating the app key</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-navy-900">
              <li>Create a new random key (32+ characters) and put it in escrow first.</li>
              <li>In Netlify, move the current value to APP_ENCRYPTION_KEY_PREVIOUS and set the new value as APP_ENCRYPTION_KEY. Redeploy.</li>
              <li>Everything still opens (the previous key is tried automatically); new files use the new key.</li>
              <li>In File encryption, run the re-encrypt job (mode “Re-encrypt to the current key”) until nothing is left.</li>
              <li>After a successful backup and a passed restore test, remove APP_ENCRYPTION_KEY_PREVIOUS. Older backups still need the old key: keep its escrow copy until those backups age out (up to 7 years).</li>
            </ol>
            <p className="mt-2 text-xs text-slate-600">Previous key configured now: {s.previousKey ? "yes" : "no"}. Full steps: docs/backup-restore.md.</p>
          </div>
        </div>
      </section>
    </>
  );
}
