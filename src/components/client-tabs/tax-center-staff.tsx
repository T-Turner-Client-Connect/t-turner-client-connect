import Link from "next/link";
import type { Actor } from "@/lib/auth/actor";
import { ActionForm } from "@/components/action-form";
import { Button, Field } from "@/components/ui";
import { taxYearProgressAction } from "@/app/actions/tax-center";
import { prisma } from "@/lib/prisma";
import { DOCUMENTS_STATUS } from "@/lib/services/tax-center";
import { identityGapLine } from "@/lib/services/tax-season";
import { utcToChicagoLocal } from "@/lib/tz";
import { QuestionnaireStatusCard } from "./questionnaire-status-card";

/**
 * Step 1 · Client info & documents: the year's questionnaire, and one line
 * only when an identity document is missing (nothing when all are on file).
 * The tax profile lives on Overview › Details; the year's progress is the
 * strip in the Taxes year header.
 */
export async function TaxCenterStaff({ clientId, user, year }: { clientId: string; user: Actor; year: number }) {
  const gap = await identityGapLine(clientId, user);
  return (
    <div className="space-y-3" data-testid="staff-tax-center">
      {gap && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="identity-gap">
          {gap}. <Link className="font-semibold underline" href={`/clients/${clientId}?tab=documents#identity`}>Documents › Identity</Link>
        </p>
      )}
      <QuestionnaireStatusCard clientId={clientId} years={[year]} />
    </div>
  );
}

/**
 * "Client progress note" (Filing history › More options): the manual
 * Documents value (used when the year has no document requests), estimated
 * completion and note to the client — the same fields and action as before,
 * so the client's My Tax Center shows exactly what it showed.
 */
export async function ClientProgressNote({ clientId, year }: { clientId: string; year: number }) {
  const p = await prisma.taxYearProgress.findUnique({ where: { clientId_taxYear: { clientId, taxYear: year } } });
  return (
    <details className="rounded-lg border border-ivory-200 bg-white p-3" data-testid="client-progress-note">
      <summary className="cursor-pointer text-sm font-semibold text-slate-700">Client progress note ({year})</summary>
      <ActionForm action={taxYearProgressAction.bind(null, clientId, year)} className="mt-2 grid gap-2 sm:grid-cols-4" showSuccess>
        <Field label="Documents" hint="Used when the year has no document requests.">
          <select className="input" name="documentsStatus" defaultValue={p?.documentsStatus ?? "NOT_STARTED"}>{Object.entries(DOCUMENTS_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </Field>
        <Field label="Estimated completion"><input className="input" type="date" name="estimatedCompletion" defaultValue={p?.estimatedCompletion ? utcToChicagoLocal(p.estimatedCompletion).slice(0, 10) : ""} /></Field>
        <Field label="Note to client (optional)"><input className="input" name="estimateNote" defaultValue={p?.estimateNote ?? ""} /></Field>
        <div className="flex items-end"><Button type="submit" variant="secondary">Save {year}</Button></div>
      </ActionForm>
    </details>
  );
}
