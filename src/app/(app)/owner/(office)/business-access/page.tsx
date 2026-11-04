import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, PageHeader } from "@/components/ui";
import { approveBusinessAccessAction, declineBusinessAccessAction, setConversionRequesterAction } from "@/app/actions/business-access";
import { ownerPermissionsManagerAction } from "@/app/actions/business-owners";

import { requireOwner } from "@/lib/auth/owner";
import { conversionCandidates, pendingBusinessRequests } from "@/lib/services/business-access";
import { fmtDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Managed Business access" };

/**
 * Owner-only. Decide conversion requests, review clients that may qualify, and choose which
 * staff may REQUEST a conversion. Nothing here converts anyone automatically.
 */
export default async function BusinessAccessPage() {
  const { actor } = await requireOwner("full");
  const [pending, candidates, staff, managed] = await Promise.all([
    pendingBusinessRequests(actor),
    conversionCandidates(actor),
    prisma.user.findMany({ where: { active: true, id: { not: actor.id } }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true, businessConversionAccess: true, ownerPermissionsAccess: true } }),
    prisma.client.findMany({ where: { businessAccess: "ACTIVE" }, orderBy: { displayName: "asc" }, select: { id: true, displayName: true, businessName: true, businessAccessChangedAt: true } }),
  ]);
  const name = (c: { displayName: string; businessName: string | null }) => c.businessName || c.displayName;
  return (
    <>
      <PageHeader title="Managed Business access" subtitle="Every client is a Regular Tax Client until you approve. Only you can approve; staff you authorize can request." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Waiting for your decision (${pending.length})`} className="lg:col-span-2">
          {pending.length === 0 ? (
            <EmptyState title="No requests waiting">Requests appear here when you or authorized staff ask to convert a client.</EmptyState>
          ) : (
            <ul className="divide-y divide-navy-100" data-testid="owner-pending-requests">
              {pending.map((r) => (
                <li key={r.id} className="py-3 text-sm">
                  <p><Link className="font-semibold text-navy-900 underline" href={`/clients/${r.client.id}?tab=portal`}>{name(r.client)}</Link> · requested by {r.requestedBy.name} · {fmtDateTime(r.createdAt)}</p>
                  <p className="mt-1">Services: {r.services.join(", ")}</p>
                  <p className="mt-1 text-slate-700">{r.reason}</p>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    <ActionForm action={approveBusinessAccessAction.bind(null, r.id, r.client.id)} className="space-y-2">
                      <Field label="Note (optional)"><input className="input" name="note" maxLength={500} /></Field>
                      <Button type="submit">Approve</Button>
                    </ActionForm>
                    <ActionForm action={declineBusinessAccessAction.bind(null, r.id, r.client.id)} className="space-y-2">
                      <Field label="Reason"><input className="input" name="note" required maxLength={500} /></Field>
                      <Button type="submit" variant="secondary">Decline</Button>
                    </ActionForm>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={`Clients to review (${candidates.length})`}>
          <p className="mb-2 text-sm text-slate-600">These Regular Tax Clients already have bookkeeping, ledger, bank or business-invoicing records with us. This list is only for review — open a client to request conversion. Nobody is converted automatically.</p>
          {candidates.length === 0 ? (
            <p className="text-sm text-slate-600">None.</p>
          ) : (
            <ul className="divide-y divide-navy-100 text-sm" data-testid="conversion-candidates">
              {candidates.map((c) => (
                <li key={c.id} className="py-2">
                  <Link className="font-semibold text-navy-900 underline" href={`/clients/${c.id}?tab=portal`}>{name(c)}</Link>
                  {c.pending && <Badge tone="gold" className="ml-2">Request waiting</Badge>}
                  <span className="block text-slate-600">{c.signals.join(" · ")}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={`Managed Business Clients (${managed.length})`}>
          {managed.length === 0 ? (
            <p className="text-sm text-slate-600">None yet.</p>
          ) : (
            <ul className="divide-y divide-navy-100 text-sm">
              {managed.map((c) => (
                <li key={c.id} className="py-2"><Link className="font-semibold text-navy-900 underline" href={`/clients/${c.id}?tab=portal`}>{name(c)}</Link>{c.businessAccessChangedAt && <span className="ml-2 text-slate-500">since {fmtDateTime(c.businessAccessChangedAt)}</span>}</li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Who may request conversions" className="lg:col-span-2">
          <p className="mb-2 text-sm text-slate-600">Authorized staff can send you a request. Only you can approve, decline or remove access.</p>
          <ul className="divide-y divide-navy-100 text-sm">
            {staff.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="flex-1">{u.name} <span className="text-slate-500">{u.email}</span></span>
                {u.businessConversionAccess && <Badge tone="green">Can request</Badge>}
                <ActionForm action={setConversionRequesterAction.bind(null, u.id, !u.businessConversionAccess)}>
                  <Button type="submit" variant="secondary">{u.businessConversionAccess ? "Remove" : "Allow requests"}</Button>
                </ActionForm>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Who may set business owners' portal permissions" className="lg:col-span-2">
          <p className="mb-2 text-sm text-slate-600">On a business client&apos;s Owners card: what each owner&apos;s login may see (documents, payroll, payroll approval, billing…) and K-1 sharing between owners. Banking stays yours to turn on.</p>
          <ul className="divide-y divide-navy-100 text-sm" data-testid="owner-permission-managers">
            {staff.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="flex-1">{u.name} <span className="text-slate-500">{u.email}</span></span>
                {u.ownerPermissionsAccess && <Badge tone="green">Can set permissions</Badge>}
                <ActionForm action={ownerPermissionsManagerAction.bind(null, u.id, !u.ownerPermissionsAccess)}>
                  <Button type="submit" variant="secondary">{u.ownerPermissionsAccess ? "Remove" : "Allow"}</Button>
                </ActionForm>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
