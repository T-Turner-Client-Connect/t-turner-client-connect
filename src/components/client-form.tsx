import type { Client, Group, User } from "@prisma/client";
import { ActionForm } from "@/components/action-form";
import { Button, Field, LinkButton } from "@/components/ui";
import type { ActionState } from "@/lib/action";
import { SpouseSection } from "@/components/spouse-section";
import { ClientAddressFields } from "@/components/client-address-fields";
import { CLIENT_SERVICE_OPTIONS } from "@/lib/service-options";
import { currentTaxYear } from "@/lib/services/clients";

export function ClientForm({
  action,
  client,
  groups,
  staff,
  selectedGroupIds = [],
  cancelHref,
  spouseYear = currentTaxYear(),
  spouseNeeded = false,
  businessReturn = false,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  client?: Client;
  groups: Group[];
  staff: Pick<User, "id" | "name">[];
  selectedGroupIds?: string[];
  cancelHref: string;
  // The current tax year and whether a spouse is needed for it (never inferred from a spouse saved earlier).
  spouseYear?: number;
  spouseNeeded?: boolean;
  // A business return (1065, 1120-S, ...) for that year: no spouse box at all.
  businessReturn?: boolean;
}) {
  const v = (k: keyof Client) => (client?.[k] as string | null | undefined) ?? "";
  const known = new Set<string>(CLIENT_SERVICE_OPTIONS);
  const otherServices = (client?.services ?? []).filter((s) => !known.has(s));
  return (
    <ActionForm action={action} className="space-y-6" showSuccess={false}>
      <section className="grid gap-4 sm:grid-cols-2">
        <Field label="First name"><input className="input" name="firstName" defaultValue={v("firstName")} autoComplete="off" /></Field>
        <Field label="Middle name / initial"><input className="input" name="middleName" defaultValue={v("middleName")} autoComplete="off" /></Field>
        <Field label="Preferred first name" hint="Used to greet them in the portal"><input className="input" name="preferredName" defaultValue={v("preferredName")} autoComplete="off" /></Field>
        <Field label="Last name"><input className="input" name="lastName" defaultValue={v("lastName")} autoComplete="off" /></Field>
        <Field label="Business name" className="sm:col-span-2" hint="For a business, set Client type to Business below; list its owners on the client page after saving.">
          <input className="input" name="businessName" defaultValue={v("businessName")} autoComplete="off" />
        </Field>
        <Field label="Email"><input className="input" type="email" name="email" defaultValue={v("email")} autoComplete="off" /></Field>
        <Field label="Mobile phone" hint="10-digit US number, or international starting with +"><input className="input" type="tel" name="phone" defaultValue={v("phone")} autoComplete="off" /></Field>
      </section>
      <section className="grid gap-4 sm:grid-cols-6">
        <ClientAddressFields
          values={{
            addressLine1: client?.addressLine1, addressLine2: client?.addressLine2, city: client?.city, state: client?.state, postalCode: client?.postalCode,
            mailingSameAsAddress: client?.mailingSameAsAddress, mailingAddressLine1: client?.mailingAddressLine1, mailingAddressLine2: client?.mailingAddressLine2,
            mailingCity: client?.mailingCity, mailingState: client?.mailingState, mailingPostalCode: client?.mailingPostalCode,
          }}
        />
      </section>
      {/* Collapsed by default, so the mailing address follows the primary contact info directly. */}
      <SpouseSection
        year={spouseYear}
        businessReturn={businessReturn}
        initialOpen={spouseNeeded}
        initialType={client?.clientType ?? "INDIVIDUAL"}
        savedEarlier={!!(client?.spouseFirstName || client?.spouseLastName)}
        values={{ spouseFirstName: v("spouseFirstName"), spouseMiddleName: v("spouseMiddleName"), spouseLastName: v("spouseLastName"), spouseEmail: v("spouseEmail"), spousePhone: v("spousePhone") }}
      />
      <section className="grid gap-4 sm:grid-cols-3">
        <Field label="Client type">
          <select className="input" name="clientType" defaultValue={client?.clientType ?? "INDIVIDUAL"}>
            <option value="INDIVIDUAL">Individual</option>
            <option value="BUSINESS">Business</option>
            <option value="NONPROFIT">Nonprofit</option>
          </select>
        </Field>
        <Field label="Status">
          <select className="input" name="status" defaultValue={client?.status ?? "ACTIVE"}>
            <option value="ACTIVE">Active</option>
            <option value="PROSPECT">Prospect</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </Field>
        <Field label="Assigned to">
          <select className="input" name="assignedToId" defaultValue={client?.assignedToId ?? ""}>
            <option value="">Unassigned</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <fieldset className="sm:col-span-3" data-testid="service-options">
          <legend className="mb-1 text-sm font-semibold text-navy-900">Services</legend>
          <p className="mb-2 text-xs text-slate-600">A business without Individual tax preparation gets a business-only portal: no personal tax questionnaire, spouse, dependents or refund options.</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {CLIENT_SERVICE_OPTIONS.map((s) => (
              <label key={s} className="flex items-center gap-2 rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm">
                <input type="checkbox" name="serviceOption" value={s} defaultChecked={client?.services.includes(s)} className="size-4 accent-navy-900" />
                {s}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Other services" className="sm:col-span-3" hint="Anything else, separated with commas">
          <input className="input" name="services" defaultValue={otherServices.join(", ")} />
        </Field>

        <Field label="Tags" className="sm:col-span-3" hint="Separate with commas">
          <input className="input" name="tags" defaultValue={client?.tags.join(", ") ?? ""} />
        </Field>
      </section>
      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-navy-900">Groups</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => (
            <label key={g.id} className="flex items-center gap-2 rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm">
              <input type="checkbox" name="groupIds" value={g.id} defaultChecked={selectedGroupIds.includes(g.id)} className="size-4 accent-navy-900" />
              {g.name}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="Notes" hint="Never store SSNs, bank details, or tax-return figures here.">
        <textarea className="input" name="notes" defaultValue={v("notes")} rows={4} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit">Save client</Button>
        <LinkButton href={cancelHref} variant="secondary">Cancel</LinkButton>
      </div>
    </ActionForm>
  );
}
