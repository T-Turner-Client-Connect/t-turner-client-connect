import type { Actor } from "@/lib/auth/actor";
import { prisma } from "@/lib/prisma";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Notice } from "@/components/ui";
import { ReturnTypeForm } from "@/components/return-type-form";
import { confirmReturnTypeAction, saveTaxPrepCaseAction } from "@/app/actions/tax-prep";
import { canEditTaxPrep, caseState } from "@/lib/services/tax-prep";
import { isJointReturn, joinName, looksCombined, parseTaxpayerName, returnTypeLabel } from "@/lib/tax/return-types";
import { fmtDateTime } from "@/lib/format";

/**
 * Tax Preparation: one case per tax year with its required Tax Return Type.
 * A joint return shows the primary taxpayer and spouse separately on the same case.
 */
export async function TaxPrepCases({ clientId, user }: { clientId: string; user: Actor }) {
  const [client, cases, canEdit] = await Promise.all([
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { firstName: true, lastName: true, displayName: true, services: true, clientType: true } }),
    prisma.taxPrepCase.findMany({ where: { clientId }, orderBy: { taxYear: "desc" } }),
    canEditTaxPrep(user, clientId),
  ]);
  const names = new Map((await prisma.user.findMany({ where: { id: { in: cases.map((c) => c.returnTypeConfirmedById).filter((v): v is string => !!v) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const thisYear = new Date().getFullYear();
  const hasTaxService = client.services.some((s) => /tax/i.test(s));
  const combined = looksCombined(client);
  // Prefill names for a new case from the client record (splitting an old combined name).
  const parsed = parseTaxpayerName(client.displayName);
  const seed = combined && parsed
    ? { primaryFirstName: parsed.primary.first, primaryMiddleName: parsed.primary.middle, primaryLastName: parsed.primary.last, spouseFirstName: parsed.spouse?.first ?? null, spouseMiddleName: parsed.spouse?.middle ?? null, spouseLastName: parsed.spouse?.last ?? null }
    : { primaryFirstName: client.firstName, primaryLastName: client.lastName };
  const missingYear = hasTaxService && !cases.some((c) => c.taxYear === thisYear - 1);

  return (
    <Card title="Tax Preparation — Tax Return Type" actions={<Badge tone="gray">One case per tax year</Badge>}>
      <div className="space-y-4" data-testid="tax-prep-cases">
        {combined && (
          <Notice tone="warn" title="This record holds two names in one">
            “{[client.firstName, client.lastName].filter(Boolean).join(" ")}” looks like a joint return saved as one person. Select 1040 – Married Filing Jointly below and confirm the primary taxpayer and spouse — the record stays one client with one joint return.
          </Notice>
        )}
        {missingYear && <Notice tone="warn">Tax Preparation is a service for this client, but the {thisYear - 1} Tax Return Type hasn’t been selected yet.</Notice>}

        {cases.map((c) => {
          const st = caseState(c);
          const joint = isJointReturn(c.returnType);
          const primary = joinName({ first: c.primaryFirstName, middle: c.primaryMiddleName, last: c.primaryLastName }) || [client.firstName, client.lastName].filter(Boolean).join(" ");
          const spouse = joinName({ first: c.spouseFirstName, middle: c.spouseMiddleName, last: c.spouseLastName });
          return (
            <section key={c.id} className="rounded-xl border border-ivory-200 p-4" data-testid={`tax-case-${c.taxYear}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-serif text-lg font-bold text-navy-900">{c.taxYear} tax year</h3>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={c.returnType ? "navy" : "red"}>{returnTypeLabel(c.returnType, c.otherReturnForm)}</Badge>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </span>
              </div>
              {joint ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-2" data-testid="joint-return">
                  <div className="rounded-lg bg-ivory-50 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Primary taxpayer</p><p className="font-semibold text-navy-900">{primary || "—"}</p></div>
                  <div className="rounded-lg bg-ivory-50 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Spouse</p><p className="font-semibold text-navy-900">{spouse || "Not entered"}</p>{(c.spouseEmail || c.spousePhone) && <p className="text-xs text-slate-600">{[c.spouseEmail, c.spousePhone].filter(Boolean).join(" · ")}</p>}</div>
                  <p className="text-xs text-slate-600 sm:col-span-2">One joint return (Married Filing Jointly) on this client record.</p>
                </div>
              ) : (
                <p className="mt-2 text-sm text-slate-700">Taxpayer: <strong>{primary || "—"}</strong>{spouse ? ` · Spouse: ${spouse}` : ""}</p>
              )}
              <p className="mt-2 text-xs text-slate-600">
                {c.returnTypeSource === "TAXACT_IMPORT" ? "Prefilled from TaxAct" : c.returnTypeSource === "STAFF" ? "Selected by staff" : "Not selected yet"}
                {c.returnTypeConfirmedAt && ` · Confirmed ${fmtDateTime(c.returnTypeConfirmedAt)} by ${names.get(c.returnTypeConfirmedById ?? "") ?? "staff"}`}
              </p>
              {canEdit && st.key === "CONFIRM" && (
                <ActionForm action={confirmReturnTypeAction.bind(null, clientId, c.id)} className="mt-2">
                  <Button type="submit" variant="gold">Confirm {returnTypeLabel(c.returnType, c.otherReturnForm)}</Button>
                </ActionForm>
              )}
              {canEdit ? (
                <details className="mt-3" open={st.key === "REQUIRED" || st.key === "SPOUSE"}>
                  <summary className="cursor-pointer text-sm font-semibold underline">{c.returnType ? "Change return type or taxpayer details" : "Select the Tax Return Type"}</summary>
                  <div className="mt-3">
                    <ReturnTypeForm
                      action={saveTaxPrepCaseAction.bind(null, clientId)}
                      taxYear={c.taxYear}
                      values={{ ...c, primaryFirstName: c.primaryFirstName ?? seed.primaryFirstName, primaryLastName: c.primaryLastName ?? seed.primaryLastName, spouseFirstName: c.spouseFirstName ?? (combined ? seed.spouseFirstName ?? null : null), spouseLastName: c.spouseLastName ?? (combined ? seed.spouseLastName ?? null : null) }}
                      submitLabel="Save & confirm"
                    />
                  </div>
                </details>
              ) : (
                <p className="mt-2 text-xs text-slate-600">Only an Admin or this client’s assigned staff member can change the return type.</p>
              )}
            </section>
          );
        })}

        {canEdit && (
          <details open={cases.length === 0}>
            <summary className="cursor-pointer text-sm font-semibold underline">Start a tax preparation case for another tax year</summary>
            <div className="mt-3">
              <ReturnTypeForm action={saveTaxPrepCaseAction.bind(null, clientId)} taxYear={thisYear - 1} yearEditable values={{ ...seed, returnType: combined ? "1040_MFJ" : null }} submitLabel="Save & confirm" />
            </div>
          </details>
        )}
        {cases.length === 0 && !canEdit && <p className="text-sm text-slate-600">No tax preparation case yet.</p>}
      </div>
    </Card>
  );
}
