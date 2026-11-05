import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { ActionForm } from "@/components/action-form";
import { CheckAll } from "@/components/check-all";
import { Badge, Button, buttonClass, Card, EmptyState, Field, LinkButton, PageHeader } from "@/components/ui";
import { InvitesSwitchCard } from "./switch-card";
import { prepareInvitationsAction } from "@/app/actions/prepared-invitations";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { clientWhere } from "@/lib/services/clients";
import { noPortalLoginWhere } from "@/lib/services/prepared-invitations";
import { CLIENT_TYPE_LABELS, fmtDateTime } from "@/lib/format";
import { ADDRESS_NEEDED_TAG, FILING_STATUS_NEEDED_TAG } from "@/lib/import/edits";

export const metadata = { title: "Prepared invitations" };

type SP = Promise<{ q?: string; show?: string; import?: string }>;

export default async function PreparedInvitationsPage({ searchParams }: { searchParams: SP }) {
  await requireUser();
  const sp = await searchParams;
  const showAll = sp.show === "all";
  const importBatch = sp.import ? await prisma.importBatch.findUnique({ where: { id: sp.import }, select: { id: true, fileName: true, committedAt: true } }) : null;
  const importClientIds = importBatch
    ? (await prisma.importRow.findMany({ where: { batchId: importBatch.id, resultClientId: { not: null } }, select: { resultClientId: true } })).map((r) => r.resultClientId!)
    : null;
  const where: Prisma.ClientWhereInput = { AND: [clientWhere({ q: sp.q }), ...(showAll ? [] : [noPortalLoginWhere]), ...(importClientIds ? [{ id: { in: importClientIds } }] : [])] };
  const [clients, count, batches, openRows] = await Promise.all([
    prisma.client.findMany({
      where,
      select: {
        id: true,
        displayName: true,
        email: true,
        clientType: true,
        tags: true,
        bookkeepingProfile: { select: { active: true } },
        _count: { select: { portalAccess: { where: { revokedAt: null } } } },
      },
      orderBy: { displayName: "asc" },
      take: 100,
    }),
    prisma.client.count({ where }),
    prisma.portalInviteBatch.findMany({ orderBy: { createdAt: "desc" }, take: 30, include: { createdBy: { select: { name: true } }, rows: { select: { approvedAt: true, sendStartedAt: true, result: true } } } }),
    prisma.portalInviteBatchRow.findMany({ where: { sendStartedAt: null }, select: { clientId: true, batch: { select: { title: true } } } }),
  ]);
  const inDraft = new Map(openRows.map((r) => [r.clientId, r.batch.title]));
  const drafts = batches.filter((b) => b.rows.some((r) => !r.sendStartedAt) || b.rows.length === 0);
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries({ ...sp, ...patch }).filter(([, v]) => v) as [string, string][]);
    return `/clients/invitations?${p.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Prepared invitations"
        subtitle="Gather clients into a draft batch, check each email and permission, and send portal invitations only after Tabitha approves them."
        actions={<LinkButton href="/clients" variant="secondary">Back to clients</LinkButton>}
      />
      <div className="mb-4">
        <InvitesSwitchCard back="/clients/invitations" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <Card title="Prepare a batch">
          <form className="mb-3 grid gap-2 sm:grid-cols-[2fr_1fr_auto]" role="search">
            {importBatch && <input type="hidden" name="import" value={importBatch.id} />}
            <label>
              <span className="sr-only">Search</span>
              <input className="input" name="q" defaultValue={sp.q} placeholder="Search name, business, email, phone" />
            </label>
            <select className="input" name="show" defaultValue={showAll ? "all" : ""} aria-label="Which clients">
              <option value="">No portal login yet</option>
              <option value="all">All current clients</option>
            </select>
            <button className={buttonClass("secondary")}>Filter</button>
          </form>
          {importBatch && (
            <p className="mb-3 rounded-lg bg-navy-50 p-3 text-sm text-navy-900" data-testid="from-import">
              Showing clients from the import <strong>{importBatch.fileName}</strong>. <Link className="underline" href={qs({ import: undefined })}>Show every client</Link>
            </p>
          )}
          {clients.length === 0 ? (
            <EmptyState title="No clients match">{showAll ? "Try a different search." : "Every client that matches already has a portal login. Choose “All current clients” to see them."}</EmptyState>
          ) : (
            <ActionForm action={prepareInvitationsAction} id="prepare">
              {importBatch && <input type="hidden" name="importBatchId" value={importBatch.id} />}
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <CheckAll name="clientIds" />
                <span className="text-xs text-slate-600">{count > clients.length ? `First ${clients.length} of ${count} — search to narrow` : `${count} client${count === 1 ? "" : "s"}`}</span>
              </div>
              <ul className="mb-4 max-h-[32rem] divide-y divide-navy-100 overflow-y-auto rounded-xl border border-navy-100" data-testid="prepare-list">
                {clients.map((c) => (
                  <li key={c.id}>
                    <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-navy-50">
                      <input type="checkbox" name="clientIds" value={c.id} className="mt-1 size-4 shrink-0 accent-navy-900" />
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-navy-900">{c.displayName}</span>
                        <span className="block truncate text-sm text-slate-600">{c.email ?? <em className="text-red-800">No email on file</em>}</span>
                        <span className="mt-1 flex flex-wrap gap-1">
                          <Badge tone="navy">{CLIENT_TYPE_LABELS[c.clientType]}</Badge>
                          {c._count.portalAccess > 0 ? <Badge tone="green">Has portal login</Badge> : <Badge tone="gray">No portal login yet</Badge>}
                          {c.bookkeepingProfile?.active && <Badge tone="gold">Bookkeeping client</Badge>}
                          {c.tags.filter((t) => t === ADDRESS_NEEDED_TAG || t === FILING_STATUS_NEEDED_TAG).map((t) => <Badge key={t} tone="amber">{t}</Badge>)}
                          {inDraft.has(c.id) && <Badge tone="gray">In draft: {inDraft.get(c.id)}</Badge>}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <Field label="Add to">
                  <select className="input" name="batchId" defaultValue="">
                    <option value="">A new draft batch</option>
                    {drafts.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
                  </select>
                </Field>
                <Field label="New batch name (optional)">
                  <input className="input" name="title" placeholder="e.g. November portal rollout" maxLength={120} />
                </Field>
                <Button type="submit">Add selected</Button>
              </div>
              <p className="mt-2 text-xs text-slate-600">Adding clients to a batch sends nothing. Each row is prefilled from the client record; you can check and edit it on the next screen.</p>
            </ActionForm>
          )}
        </Card>

        <Card title="Batches">
          {batches.length === 0 ? (
            <p className="text-sm text-slate-600">No batches yet.</p>
          ) : (
            <ul className="divide-y divide-navy-100" data-testid="batch-list">
              {batches.map((b) => {
                const approved = b.rows.filter((r) => r.approvedAt && !r.sendStartedAt).length;
                const draft = b.rows.filter((r) => !r.approvedAt && !r.sendStartedAt).length;
                const sent = b.rows.filter((r) => r.result === "SENT").length;
                const done = b.rows.filter((r) => r.sendStartedAt).length;
                return (
                  <li key={b.id} className="py-2.5">
                    <Link href={`/clients/invitations/${b.id}`} className="font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">{b.title}</Link>
                    <p className="text-xs text-slate-600">{b.rows.length} row{b.rows.length === 1 ? "" : "s"} · {b.createdBy.name} · {fmtDateTime(b.createdAt)}</p>
                    <p className="mt-1 flex flex-wrap gap-1">
                      {draft > 0 && <Badge tone="gray">{draft} draft</Badge>}
                      {approved > 0 && <Badge tone="navy">{approved} approved</Badge>}
                      {done > 0 && <Badge tone="gold">{sent} sent of {done} processed</Badge>}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
