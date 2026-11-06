import { EyeOff } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Button } from "@/components/ui";
import { assignIdentityToOwnerAction } from "@/app/actions/identity";
import { ID_ROLES, ID_STATUS, ID_TYPES, isAdminOnlyType, type IdRole, type IdType, type unassignedBusinessIdentity } from "@/lib/services/identity";
import { fmtDateTime } from "@/lib/format";

type Data = NonNullable<Awaited<ReturnType<typeof unassignedBusinessIdentity>>>;

/**
 * Staff view, business accounts: identity documents filed on the business's own record (not tied to
 * an owner). Staff-only — hidden from every portal login — until assigned to the owner they belong
 * to. Assigning never deletes or moves the file; it's written to the audit log.
 */
export function IdentityAssignPanel({ clientId, data, viewerIsAdmin }: { clientId: string; data: Data; viewerIsAdmin: boolean }) {
  if (!data.records.length) return null;
  return (
    <section className="mb-4 rounded-2xl border border-amber-300 bg-amber-50/70 p-4" data-testid="identity-unassigned">
      <h3 className="flex items-center gap-2 font-serif text-lg font-bold text-navy-900">
        <EyeOff className="size-5 text-amber-700" aria-hidden />
        Not assigned to an owner — staff only
      </h3>
      <p className="mt-1 text-sm text-slate-700">
        These identity documents were filed on the business&apos;s own record. No portal login can see or open them. Assign each to the owner it belongs to; only that owner will then see it in the portal (Social Security cards and birth certificates stay Admin-only).
      </p>
      <ul className="mt-3 divide-y divide-amber-200">
        {data.records.map((r) => {
          const adminOnly = isAdminOnlyType(r.type);
          return (
            <li key={r.id} className="flex flex-col gap-2 py-3 md:flex-row md:items-end md:justify-between" data-unassigned={r.id}>
              <div className="min-w-0">
                <p className="font-semibold text-navy-900">{ID_TYPES[r.type as IdType]?.label ?? r.type} <span className="font-normal text-slate-600">· filed under {r.person.name} ({ID_ROLES[r.person.role as IdRole] ?? r.person.role})</span></p>
                <p className="text-xs text-slate-600">Uploaded {fmtDateTime(r.createdAt)} · <Badge tone="gray">{ID_STATUS[r.status as keyof typeof ID_STATUS] ?? r.status}</Badge> · <Badge tone="amber">Hidden from the portal</Badge></p>
              </div>
              {adminOnly && !viewerIsAdmin ? (
                <p className="text-xs text-slate-600">An Admin assigns this document.</p>
              ) : data.owners.length === 0 ? (
                <p className="text-xs text-slate-600">Add the business&apos;s owners first.</p>
              ) : (
                <ActionForm action={assignIdentityToOwnerAction.bind(null, clientId, r.id)} className="flex flex-wrap items-end gap-2">
                  <label className="block">
                    <span className="mb-1 block text-xs text-slate-600">Owner</span>
                    <select className="input" name="businessOwnerId" required defaultValue="">
                      <option value="" disabled>Choose…</option>
                      {data.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  </label>
                  <label className="flex items-center gap-1 text-xs text-slate-700"><input type="checkbox" name="confirm" value="1" required /> It&apos;s this owner&apos;s document</label>
                  <Button type="submit" variant="secondary">Assign to owner</Button>
                </ActionForm>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
