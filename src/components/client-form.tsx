import type { Client, Group, User } from "@prisma/client";
import { ActionForm } from "@/components/action-form";
import { Button, Field, LinkButton } from "@/components/ui";
import type { ActionState } from "@/lib/action";

export function ClientForm({
  action,
  client,
  groups,
  staff,
  selectedGroupIds = [],
  cancelHref,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  client?: Client;
  groups: Group[];
  staff: Pick<User, "id" | "name">[];
  selectedGroupIds?: string[];
  cancelHref: string;
}) {
  const v = (k: keyof Client) => (client?.[k] as string | null | undefined) ?? "";
  return (
    <ActionForm action={action} className="space-y-6" showSuccess={false}>
      <section className="grid gap-4 sm:grid-cols-2">
        <Field label="First name"><input className="input" name="firstName" defaultValue={v("firstName")} autoComplete="off" /></Field>
        <Field label="Preferred first name" hint="Used to greet them in the portal"><input className="input" name="preferredName" defaultValue={v("preferredName")} autoComplete="off" /></Field>
        <Field label="Last name"><input className="input" name="lastName" defaultValue={v("lastName")} autoComplete="off" /></Field>
        <Field label="Business name" className="sm:col-span-2" hint="For a business, add the people you work with as contacts after saving.">
          <input className="input" name="businessName" defaultValue={v("businessName")} autoComplete="off" />
        </Field>
        <Field label="Email"><input className="input" type="email" name="email" defaultValue={v("email")} autoComplete="off" /></Field>
        <Field label="Mobile phone" hint="10-digit US number, or international starting with +"><input className="input" type="tel" name="phone" defaultValue={v("phone")} autoComplete="off" /></Field>
      </section>
      <section className="grid gap-4 sm:grid-cols-6">
        <Field label="Mailing address" className="sm:col-span-6"><input className="input" name="addressLine1" defaultValue={v("addressLine1")} autoComplete="off" /></Field>
        <Field label="Address line 2" className="sm:col-span-6"><input className="input" name="addressLine2" defaultValue={v("addressLine2")} autoComplete="off" /></Field>
        <Field label="City" className="sm:col-span-3"><input className="input" name="city" defaultValue={v("city")} autoComplete="off" /></Field>
        <Field label="State" className="sm:col-span-1"><input className="input" name="state" maxLength={2} defaultValue={v("state")} autoComplete="off" /></Field>
        <Field label="ZIP" className="sm:col-span-2"><input className="input" name="postalCode" defaultValue={v("postalCode")} autoComplete="off" /></Field>
      </section>
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
        <Field label="Services" className="sm:col-span-3" hint="Separate with commas, e.g. Tax preparation, Bookkeeping">
          <input className="input" name="services" defaultValue={client?.services.join(", ") ?? ""} />
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
