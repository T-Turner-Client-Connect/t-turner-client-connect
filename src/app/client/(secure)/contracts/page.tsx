import Link from "next/link";
import { Badge, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { prisma } from "@/lib/prisma";
import { SIGNATURE_LABELS } from "@/lib/services/signatures";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Forms & signatures" };

export default async function PortalContracts({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  const q = `?account=${current.clientId}`;
  const [contracts, signatures] = await Promise.all([
    current.canViewContracts ? prisma.contractAssignment.findMany({ where: { clientId: current.clientId, status: { not: "CANCELLED" } }, orderBy: { createdAt: "desc" } }) : [],
    current.canViewTax ? prisma.signatureRequest.findMany({ where: { clientId: current.clientId, status: { not: "DRAFT" } }, orderBy: { createdAt: "desc" } }) : [],
  ]);
  return (
    <>
      <PageHeader title="Forms & signatures" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Agreements & forms">
          {!current.canViewContracts ? (
            <Notice>Not included in your access to this account.</Notice>
          ) : contracts.length === 0 ? (
            <EmptyState title="Nothing to complete" />
          ) : (
            <ul className="divide-y divide-navy-100">
              {contracts.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <Link className="font-semibold underline" href={`/client/contracts/${c.id}${q}`}>{c.title}</Link>
                    {c.dueAt && <span className="block text-xs text-slate-600">Due {fmtDate(c.dueAt)}</span>}
                  </span>
                  <Badge tone={c.status === "COMPLETED" ? "green" : "amber"}>{c.status === "COMPLETED" ? "Completed" : c.status === "SUBMITTED" ? "Submitted" : "To complete"}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Tax document signatures">
          {signatures.length === 0 ? (
            <EmptyState title="No signature requests">When your tax documents are ready to sign, we&apos;ll notify you and they&apos;ll appear here.</EmptyState>
          ) : (
            <ul className="divide-y divide-navy-100 text-sm">{signatures.map((s) => <li key={s.id} className="py-2"><strong>{s.title}</strong> · {SIGNATURE_LABELS[s.status]}</li>)}</ul>
          )}
        </Card>
      </div>
    </>
  );
}
