import { ActionForm } from "@/components/action-form";
import { Button, Field } from "@/components/ui";
import { taxProfileAction } from "@/app/actions/tax-center";
import { setTaxSoftwareIdAction } from "@/app/actions/tax";
import { ENTITY_TYPES } from "@/lib/tax/deadlines";
import { MONTHS } from "@/lib/services/bookkeeping";

/**
 * Overview › Details: the client's tax details in one place — TaxAct client ID
 * (matches e-file status imports) and the tax profile that drives deadline
 * countdowns. Same actions and validation as on the Taxes tab before.
 */
export function TaxDetails({ client }: { client: { id: string; clientType: string; taxSoftwareId: string | null; entityType: string | null; fiscalYearEnd: number | null } }) {
  const fye = client.fiscalYearEnd ?? 12;
  return (
    <div className="sm:col-span-2" id="tax-details" data-testid="tax-details">
      <dt className="font-semibold text-slate-600">Tax details</dt>
      <dd>
        TaxAct ID {client.taxSoftwareId ?? "not set"} · {client.entityType ? ENTITY_TYPES[client.entityType as keyof typeof ENTITY_TYPES] ?? client.entityType : client.clientType === "INDIVIDUAL" ? "Individual (Form 1040 dates)" : "Entity type not recorded"} · Tax year ends {MONTHS[fye - 1]}
        <details className="mt-1">
          <summary className="cursor-pointer text-sm underline">Edit tax details</summary>
          <div className="mt-2 grid gap-3 rounded-lg border border-ivory-200 p-3">
            <ActionForm action={setTaxSoftwareIdAction.bind(null, client.id)} className="flex flex-wrap items-end gap-2">
              <Field label="TaxAct client ID" hint="Used to match e-file status imports. Records are never matched by name alone.">
                <input className="input" name="taxSoftwareId" defaultValue={client.taxSoftwareId ?? ""} />
              </Field>
              <Button type="submit" variant="secondary">Save</Button>
            </ActionForm>
            <ActionForm action={taxProfileAction.bind(null, client.id)} className="grid gap-2 sm:grid-cols-3">
              <Field label="Entity type" hint={client.clientType === "INDIVIDUAL" ? "Individuals use the Form 1040 dates." : undefined}>
                <select className="input" name="entityType" defaultValue={client.entityType ?? ""}>
                  <option value="">Not recorded</option>
                  {Object.entries(ENTITY_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="Tax year ends" hint="Fiscal-year businesses get calculated dates, labeled as such. Drives deadline countdowns.">
                <select className="input" name="fiscalYearEnd" defaultValue={fye}>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}{i === 11 ? " (calendar year)" : ""}</option>)}
                </select>
              </Field>
              <div className="flex items-end"><Button type="submit" variant="secondary">Save tax profile</Button></div>
            </ActionForm>
          </div>
        </details>
      </dd>
    </div>
  );
}
