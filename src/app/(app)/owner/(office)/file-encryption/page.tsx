import { notFound } from "next/navigation";
import clsx from "clsx";
import { FileLock2 } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Notice, PageHeader, Stat } from "@/components/ui";
import { fmtBytes, securityCard, StatusPill } from "@/components/owner/doc-security-bits";
import { requireOffice } from "@/lib/auth/owner";
import { currentJob, encryptionDryRun, encryptionStatus, ORIGINAL_HOLD_DAYS } from "@/lib/services/file-encryption";
import { FILE_GROUPS, GROUP_LABEL, ONLY_IN_CLIENT_CONNECT, type FileGroup } from "@/lib/doc-security/inventory";
import { encryptionDryRunAction, pauseEncryptionAction, removeOriginalsAction, runEncryptionBatchAction, startEncryptionAction } from "@/app/actions/doc-security";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "File encryption" };

const btn = (primary = true) => clsx("inline-flex min-h-10 items-center rounded-lg px-4 py-2 text-sm font-semibold shadow", primary ? "bg-navy-900 text-white hover:bg-navy-800" : "border-[1.5px] border-navy-900 bg-white text-navy-900");

export default async function FileEncryptionPage() {
  const { actor, access } = await requireOffice();
  if (!access.isOwner) notFound();
  const [st, dry, rekey, job] = await Promise.all([encryptionStatus(), encryptionDryRun({ actor }, "ENCRYPT"), encryptionDryRun({ actor }, "REKEY"), currentJob()]);
  const order: FileGroup[] = job?.groupOrder?.length ? (job.groupOrder as FileGroup[]) : [...FILE_GROUPS];
  const total = st.encrypted + st.plaintext;
  const pct = total ? Math.round((st.encrypted / total) * 100) : 100;

  return (
    <>
      <PageHeader title="File encryption" subtitle="Every new file is encrypted when it's saved. This page moves files saved before that into encrypted storage — only when you start it, in batches you can stop at any time. Originals are kept until you remove them." />
      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Encrypted" value={`${pct}%`} hint={`${st.encrypted.toLocaleString()} of ${total.toLocaleString()} files`} />
        <Stat label="Still to encrypt" value={dry.files.toLocaleString()} hint={fmtBytes(dry.bytes)} />
        <Stat label="Originals kept" value={st.pendingOriginals.toLocaleString()} hint={`${st.eligibleOriginals} may be removed now`} />
        <Stat label="Failures" value={(job?.failedFiles ?? 0).toLocaleString()} hint="Left untouched; retried each batch" />
      </div>

      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <section className={securityCard} data-testid="encryption-dry-run">
          <h2 className="flex items-center gap-3 font-serif text-xl font-bold text-navy-900"><FileLock2 className="size-7 text-gold-600" aria-hidden /> What a run would do (dry run)</h2>
          <p className="mt-1 text-sm text-navy-800">Counts and sizes by record type, in the order they&apos;d be processed. Nothing is read or changed to make this list.</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-600"><tr><th className="py-2 pr-3">Record type</th><th className="pr-3 text-right">Files</th><th className="pr-3 text-right">Size</th><th className="text-right">Encrypted now</th></tr></thead>
              <tbody className="divide-y divide-ivory-200">
                {st.byGroup.map((g) => {
                  const d = dry.groups.find((x) => x.group === g.group);
                  return (
                    <tr key={g.group}>
                      <td className="py-2 pr-3 text-navy-900">{g.label}{ONLY_IN_CLIENT_CONNECT.includes(g.group) && <span className="ml-2 rounded-full bg-gold-100 px-2 py-0.5 text-[11px] font-semibold text-gold-700">Only in Client Connect</span>}</td>
                      <td className="pr-3 text-right tabular-nums">{(d?.files ?? 0).toLocaleString()}</td>
                      <td className="pr-3 text-right tabular-nums">{fmtBytes(d?.bytes ?? 0)}{d?.unknownSize ? <span className="text-xs text-slate-600"> +{d.unknownSize} unsized</span> : null}</td>
                      <td className="text-right tabular-nums">{(g.files - g.plaintext).toLocaleString()} / {g.files.toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rekey.files > 0 && <Notice tone="info">{rekey.files} file{rekey.files === 1 ? " is" : "s are"} encrypted with an earlier key. After a key rotation, run the job in “Re-encrypt” mode.</Notice>}
        </section>

        <section className={securityCard} data-testid="encryption-run">
          <h2 className="font-serif text-xl font-bold text-navy-900">Run</h2>
          <p className="mt-1 text-sm text-navy-800">Per file: read → encrypt → write to a new place → read back and check the fingerprint → switch the record over. A file that fails is left exactly as it was.</p>
          <ActionForm action={startEncryptionAction} className="mt-3 space-y-3">
            <fieldset>
              <legend className="mb-1 text-sm font-semibold text-navy-900">Order (records that exist only in Client Connect first)</legend>
              <ol className="space-y-1 text-sm">
                {order.slice(0, 8).map((g, i) => (
                  <li key={g} className="flex items-center gap-2">
                    <select name="order" defaultValue={g} className="input py-1 text-sm" aria-label={`Position ${i + 1}`}>
                      {FILE_GROUPS.map((x) => <option key={x} value={x}>{i + 1}. {GROUP_LABEL[x]}</option>)}
                    </select>
                  </li>
                ))}
              </ol>
              <p className="mt-1 text-xs text-slate-600">Anything not listed follows in the usual order.</p>
            </fieldset>
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-navy-900">Mode</span>
              <select name="mode" className="input w-full"><option value="ENCRYPT">Encrypt files saved before encryption</option><option value="REKEY">Re-encrypt to the current key (after a rotation)</option></select>
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={btn()} data-testid="start-encryption">{job ? "Run the next batch" : "Start (first batch)"}</button>
            </div>
          </ActionForm>
          <ActionForm action={encryptionDryRunAction} className="mt-2 flex flex-wrap items-center gap-2">
            <input type="hidden" name="mode" value="ENCRYPT" />
            <button type="submit" className={btn(false)} data-testid="dry-run">Dry run (counts only)</button>
          </ActionForm>
          {job && (
            <div className="mt-4 border-t border-ivory-200 pt-3 text-sm">
              <p className="flex flex-wrap items-center gap-2"><StatusPill status={job.status} /> {job.doneFiles.toLocaleString()} of {job.totalFiles.toLocaleString()} moved · {job.batches} batch{job.batches === 1 ? "" : "es"}{job.lastBatchAt ? ` · last ${fmtDateTime(job.lastBatchAt)}` : ""}</p>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-ivory-200" aria-hidden><div className="h-full bg-gold-500" style={{ width: `${job.totalFiles ? Math.round((job.doneFiles / job.totalFiles) * 100) : 100}%` }} /></div>
              <div className="mt-3 flex flex-wrap gap-2">
                <ActionForm action={runEncryptionBatchAction}><button type="submit" className={btn(false)}>Run a batch</button></ActionForm>
                <ActionForm action={pauseEncryptionAction.bind(null, job.id)}><button type="submit" className={btn(false)}>Pause</button></ActionForm>
              </div>
            </div>
          )}
        </section>
      </div>

      <section className={clsx(securityCard, "mt-5")} data-testid="encryption-failures">
        <h2 className="font-serif text-xl font-bold text-navy-900">Failures</h2>
        {st.failures.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">None.</p>
        ) : (
          <ul className="mt-2 divide-y divide-ivory-200 text-sm">
            {st.failures.map((f) => (
              <li key={f.id} className="py-2">
                <span className="font-semibold text-navy-900">{GROUP_LABEL[f.group as FileGroup] ?? f.group}</span> · {f.sourceType} {f.sourceId.slice(-6)} · {f.attempts} attempt{f.attempts === 1 ? "" : "s"}
                <p className="text-xs text-red-800">{f.lastError}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={clsx(securityCard, "mt-5")} data-testid="originals">
        <h2 className="font-serif text-xl font-bold text-navy-900">Originals</h2>
        <p className="mt-1 text-sm text-navy-800">The unencrypted originals stay in storage after each file is moved. They can be removed only {ORIGINAL_HOLD_DAYS}+ days after the move AND once a successful backup holds the encrypted copy. {st.pendingOriginals} kept{st.oldestPendingAt ? `, the oldest from ${fmtDateTime(st.oldestPendingAt)}` : ""}; {st.eligibleOriginals} eligible now.</p>
        {st.eligibleOriginals > 0 && (
          <ActionForm action={removeOriginalsAction} className="mt-3 flex flex-wrap items-end gap-2">
            <label className="block text-sm"><span className="mb-1 block font-semibold text-navy-900">Type REMOVE ORIGINALS</span><input name="confirm" className="input" autoComplete="off" /></label>
            <button type="submit" className="inline-flex min-h-10 items-center rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50">Remove eligible originals</button>
          </ActionForm>
        )}
      </section>
    </>
  );
}
