import type { Actor } from "@/lib/auth/actor";
import { ActionForm } from "@/components/action-form";
import { canStaffViewIdentity, CHECKLIST_LABEL, identityChecklist } from "@/lib/services/identity";
import { Badge, Button, Card, Field } from "@/components/ui";
import { linkSubmissionAction, previewSubmissionAction, taxProfileAction, taxYearProgressAction } from "@/app/actions/tax-center";
import { prisma } from "@/lib/prisma";
import { DOCUMENTS_STATUS, submissionAnswers, taxYearStatuses } from "@/lib/services/tax-center";
import { ENTITY_TYPES } from "@/lib/tax/deadlines";
import { jotformStatus } from "@/lib/services/contracts";
import { MONTHS } from "@/lib/services/bookkeeping";
import { fmtDateTime } from "@/lib/format";
import { utcToChicagoLocal } from "@/lib/tz";

const SOURCE = { jotform_webhook: "Client submitted (verified with Jotform)", staff_import: "Imported by staff (read from Jotform)", staff_verified: "Linked by staff (Jotform not connected)" } as Record<string, string>;

/** Staff view of the client's My Tax Center: profile for deadlines, yearly statuses, questionnaire imports. */
export async function TaxCenterStaff({ clientId, user }: { clientId: string; user: Actor }) {
  const thisYear = new Date().getFullYear();
  const years = [thisYear - 1, thisYear, thisYear - 2];
  const [client, statuses, progress, subs] = await Promise.all([
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { clientType: true, entityType: true, fiscalYearEnd: true } }),
    taxYearStatuses(clientId, years),
    prisma.taxYearProgress.findMany({ where: { clientId, taxYear: { in: years } } }),
    prisma.questionnaireSubmission.findMany({ where: { clientId }, orderBy: [{ taxYear: "desc" }, { createdAt: "desc" }] }),
  ]);
  const names = new Map((await prisma.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const jf = jotformStatus();
  const idList = (await canStaffViewIdentity(user, clientId)) ? await identityChecklist(clientId) : null;

  return (
    <div className="space-y-4" data-testid="staff-tax-center">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Tax profile (drives deadline countdowns)">
          <ActionForm action={taxProfileAction.bind(null, clientId)} className="grid gap-2 sm:grid-cols-2">
            <Field label="Entity type" hint={client.clientType === "INDIVIDUAL" ? "Individuals use the Form 1040 dates." : undefined}>
              <select className="input" name="entityType" defaultValue={client.entityType ?? ""}>
                <option value="">Not recorded</option>
                {Object.entries(ENTITY_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="Tax year ends" hint="Fiscal-year businesses get calculated dates, labeled as such.">
              <select className="input" name="fiscalYearEnd" defaultValue={client.fiscalYearEnd ?? 12}>
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}{i === 11 ? " (calendar year)" : ""}</option>)}
              </select>
            </Field>
            <div><Button type="submit" variant="secondary">Save profile</Button></div>
          </ActionForm>
        </Card>

        <Card title="Link an existing Jotform questionnaire">
          <p className="mb-2 text-sm text-slate-600">
            If the client already completed a questionnaire, link it here so they aren&apos;t asked again. The submission&apos;s email must match this client, or you confirm and note how you verified it. Uploaded files are saved to this client&apos;s yearly vault as staff-only drafts for review. Jotform: <strong>{jf.label}</strong>.
          </p>
          <ActionForm action={previewSubmissionAction} className="mb-3 flex flex-wrap items-end gap-2">
            <Field label="Jotform submission ID"><input className="input" name="submissionId" inputMode="numeric" required /></Field>
            <Button type="submit" variant="ghost">Preview match</Button>
          </ActionForm>
          <ActionForm action={linkSubmissionAction.bind(null, clientId)} className="grid gap-2 sm:grid-cols-2" resetOnSuccess>
            <Field label="Jotform submission ID"><input className="input" name="submissionId" inputMode="numeric" required /></Field>
            <Field label="Tax year">
              <select className="input" name="taxYear" defaultValue={thisYear - 1}>{Array.from({ length: thisYear - 2021 }, (_, i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}</select>
            </Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="confirmed" /> I confirmed this submission belongs to this client (needed when the email doesn&apos;t match)</label>
            <Field label="How you confirmed it" className="sm:col-span-2"><input className="input" name="matchNote" placeholder="e.g. Called client 3/2, confirmed name and last 4 of SSN" /></Field>
            <div><Button type="submit">Link to this client</Button></div>
          </ActionForm>
        </Card>
      </div>

      <Card title="My Tax Center — status by tax year">
        <p className="mb-3 text-sm text-slate-600">Each step is separate: a questionnaire or upload never marks a return prepared, filed or accepted. Preparation and filing come from the filings below.</p>
        <div className="space-y-4">
          {statuses.map((y) => {
            const p = progress.find((x) => x.taxYear === y.year);
            return (
              <div key={y.year} className="rounded-xl border border-ivory-200 p-3" data-year={y.year}>
                <p className="mb-2 font-semibold">{y.year}</p>
                <ol className="mb-2 grid gap-2 sm:grid-cols-5">
                  {y.steps.map((s) => (
                    <li key={s.key} className={`rounded-lg p-2 text-sm ${s.done ? "bg-emerald-50" : "bg-ivory-50"}`}>
                      <span className="block text-[11px] font-semibold uppercase text-slate-500">{s.label}</span>
                      {s.value}
                    </li>
                  ))}
                </ol>
                <ActionForm action={taxYearProgressAction.bind(null, clientId, y.year)} className="grid gap-2 sm:grid-cols-4" showSuccess>
                  <Field label="Documents">
                    <select className="input" name="documentsStatus" defaultValue={p?.documentsStatus ?? "NOT_STARTED"}>{Object.entries(DOCUMENTS_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                  </Field>
                  <Field label="Estimated completion"><input className="input" type="date" name="estimatedCompletion" defaultValue={p?.estimatedCompletion ? utcToChicagoLocal(p.estimatedCompletion).slice(0, 10) : ""} /></Field>
                  <Field label="Note to client (optional)"><input className="input" name="estimateNote" defaultValue={p?.estimateNote ?? ""} /></Field>
                  <div className="flex items-end"><Button type="submit" variant="secondary">Save {y.year}</Button></div>
                </ActionForm>
              </div>
            );
          })}
        </div>
      </Card>

      {idList && (
        <Card title="Identity documents on file (used for every tax year)">
          <ul className="grid gap-2 text-sm md:grid-cols-2" data-testid="staff-identity-checklist">
            {idList.map(({ person, items }) => (
              <li key={person.id} className="rounded-lg bg-ivory-50 p-2">
                <strong>{person.name}</strong>
                {items.map((i) => <span key={i.type} className="block">{i.label}: {CHECKLIST_LABEL[i.state as keyof typeof CHECKLIST_LABEL]}</span>)}
              </li>
            ))}
          </ul>
          <a href={`/clients/${clientId}?tab=documents#identity`} className="mt-2 inline-block text-sm underline">Open Identity Documents</a>
        </Card>
      )}

      {subs.length > 0 && (
        <Card title="Questionnaires on file">
          <ul className="divide-y divide-navy-100 text-sm" data-testid="linked-questionnaires">
            {subs.map((s) => {
              const answers = submissionAnswers(s);
              return (
                <li key={s.id} className="py-2">
                  <p>
                    <strong>{s.taxYear}</strong> · submission {s.submissionId} · <Badge tone="green">{SOURCE[s.source] ?? s.source}</Badge>
                    <span className="block text-xs text-slate-600">
                      {s.submittedAt && `Submitted ${fmtDateTime(s.submittedAt)} · `}Linked {fmtDateTime(s.createdAt)}{s.linkedById && ` by ${names.get(s.linkedById) ?? "staff"}`} · Match: {s.matchNote} · {s.documentIds.length} file{s.documentIds.length === 1 ? "" : "s"}
                    </span>
                  </p>
                  {answers.length > 0 && (
                    <details>
                      <summary className="cursor-pointer text-xs underline">Answers ({answers.length}) — staff only</summary>
                      <dl className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                        {answers.map((a, i) => (
                          <div key={i}><dt className="text-xs text-slate-500">{a.q}</dt><dd className="whitespace-pre-wrap">{a.a}</dd></div>
                        ))}
                      </dl>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
