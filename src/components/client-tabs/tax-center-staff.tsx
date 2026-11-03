import type { Actor } from "@/lib/auth/actor";
import { ActionForm } from "@/components/action-form";
import { canStaffViewIdentity, checklistText, identityChecklist } from "@/lib/services/identity";
import { Button, Card, Field } from "@/components/ui";
import { taxProfileAction, taxYearProgressAction } from "@/app/actions/tax-center";
import { prisma } from "@/lib/prisma";
import { DOCUMENTS_STATUS, taxYearStatuses } from "@/lib/services/tax-center";
import { ENTITY_TYPES } from "@/lib/tax/deadlines";
import { MONTHS } from "@/lib/services/bookkeeping";
import { utcToChicagoLocal } from "@/lib/tz";
import { QuestionnaireStatusCard } from "./questionnaire-status-card";


/** Staff view of the client's My Tax Center: profile for deadlines, yearly statuses, questionnaire imports. */
export async function TaxCenterStaff({ clientId, user }: { clientId: string; user: Actor }) {
  const thisYear = new Date().getFullYear();
  const years = [thisYear - 1, thisYear, thisYear - 2];
  const [client, statuses, progress] = await Promise.all([
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { clientType: true, entityType: true, fiscalYearEnd: true } }),
    taxYearStatuses(clientId, years),
    prisma.taxYearProgress.findMany({ where: { clientId, taxYear: { in: years } } }),
  ]);
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

        <QuestionnaireStatusCard clientId={clientId} years={years} />
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
                {items.map((i) => <span key={i.type} className="block">{i.label}: {checklistText(i)}</span>)}
              </li>
            ))}
          </ul>
          <a href={`/clients/${clientId}?tab=documents#identity`} className="mt-2 inline-block text-sm underline">Open Identity Documents</a>
        </Card>
      )}

    </div>
  );
}
