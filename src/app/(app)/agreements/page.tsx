import Link from "next/link";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { AttorneyNote, StatusBadge } from "@/components/agreements/bits";
import { Badge, Button, Card, EmptyState, Field, LinkButton, Notice, PageHeader } from "@/components/ui";
import { assignJotformAction } from "@/app/actions/agreements";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { attorneyNoteDismissed, listAgreements, templates } from "@/lib/services/agreements";
import { contractFormUrl, jotformStatus } from "@/lib/services/contracts";
import { STATUS_LABELS } from "@/lib/agreements/catalog";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Agreements" };

/** Every client agreement in one list, with filters; Jotform contracts (older or special) at the bottom. */
export default async function AgreementsPage({ searchParams }: { searchParams: Promise<{ type?: string; status?: string; client?: string }> }) {
  await connection();
  const user = await requireUser();
  const sp = await searchParams;
  const [rows, tpls, owner, dismissed, withAgreements, jotform, allClients] = await Promise.all([
    listAgreements({ template: sp.type || undefined, status: sp.status || undefined, clientId: sp.client || undefined }),
    templates(),
    isReportApprover(user),
    attorneyNoteDismissed(user),
    prisma.client.findMany({ where: { agreements: { some: {} } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }),
    prisma.contractAssignment.findMany({ orderBy: { createdAt: "desc" }, take: 200, include: { client: { select: { id: true, displayName: true } }, pdfDocument: { select: { title: true } } } }),
    prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }),
  ]);
  const jot = jotformStatus();
  const filtered = !!(sp.type || sp.status || sp.client);

  return (
    <>
      <PageHeader
        title="Agreements"
        subtitle="Contracts and agreements for every client and service. Staff draft; Tabitha sends. Nothing is sent automatically."
        actions={
          <>
            <LinkButton href="/agreements/new" variant="gold" data-testid="new-agreement">+ New agreement</LinkButton>
            <LinkButton href="/agreements/bulk" variant="secondary">Create for several clients</LinkButton>
            <LinkButton href="/agreements/library" variant="secondary">{owner ? "Clauses & templates" : "Clause library"}</LinkButton>
          </>
        }
      />
      {owner && !dismissed && <div className="mb-4"><AttorneyNote /></div>}

      <form method="get" className="mb-4 grid gap-2 rounded-xl border border-navy-100 bg-white p-3 sm:grid-cols-4" data-testid="agreement-filters">
        <Field label="Type">
          <select className="input" name="type" defaultValue={sp.type ?? ""}><option value="">All types</option>{tpls.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select>
        </Field>
        <Field label="Status">
          <select className="input" name="status" defaultValue={sp.status ?? ""}><option value="">All statuses</option>{Object.entries(STATUS_LABELS).filter(([k]) => k !== "VOID").map(([k, v]) => <option key={k} value={k}>{v}</option>)}<option value="VOID">Void</option></select>
        </Field>
        <Field label="Client">
          <select className="input" name="client" defaultValue={sp.client ?? ""}><option value="">All clients</option>{withAgreements.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}</select>
        </Field>
        <div className="flex items-end gap-2"><Button type="submit" variant="secondary">Filter</Button>{filtered && <Link href="/agreements" className="min-h-11 py-2.5 text-sm underline">Clear</Link>}</div>
      </form>

      {rows.length === 0 ? (
        <EmptyState title={filtered ? "No agreements match" : "No agreements yet"}>Use “New agreement” to prepare one for any client and service.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-navy-100 bg-white">
          <table className="w-full min-w-[760px] text-sm" data-testid="agreements-table">
            <thead className="bg-navy-50 text-left text-navy-900"><tr><th className="px-3 py-2">Client</th><th className="px-3 py-2">Agreement</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Sent</th><th className="px-3 py-2">Signed</th><th className="px-3 py-2">Invoice</th></tr></thead>
            <tbody className="divide-y divide-navy-100">
              {rows.map((a) => (
                <tr key={a.id} data-testid="agreement-row">
                  <td className="px-3 py-2 font-medium"><Link className="underline" href={`/clients/${a.clientId}?tab=services`}>{a.clientLabel}</Link></td>
                  <td className="px-3 py-2"><Link className="font-semibold text-navy-900 underline" href={`/agreements/${a.id}`}>{a.title}</Link></td>
                  <td className="px-3 py-2 text-slate-700">{a.template.name}</td>
                  <td className="px-3 py-2"><StatusBadge status={a.display} /></td>
                  <td className="px-3 py-2 whitespace-nowrap">{a.sentAt ? fmtDate(a.sentAt) : "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{a.signedAt ? fmtDate(a.signedAt) : a.declinedAt ? `Declined ${fmtDate(a.declinedAt)}` : "—"}</td>
                  <td className="px-3 py-2">{a.invoices.length ? a.invoices.map((i) => <Link key={i.id} className="mr-2 underline" href={`/owner/invoices/${i.id}`}>{i.number}</Link>) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Card className="mt-8" title="Jotform contracts" actions={<Badge tone={jot.verifiedCompletion ? "green" : "amber"}>{jot.verifiedCompletion ? "Connected" : "Completion tracking: setup required"}</Badge>}>
        <div data-testid="firm-jotform">
          <p className="mb-3 text-sm text-slate-700">New agreements are made above in Client Connect. Use Jotform only for older contracts or special ones you still build in Jotform.</p>
          {!jot.verifiedCompletion && <div className="mb-3"><Notice tone="warn">{jot.label}. Until then, staff confirm completion on the client&apos;s Agreements &amp; Invoices tab after checking the submission in Jotform.</Notice></div>}
          {jotform.length === 0 ? <p className="mb-3 text-sm text-slate-600">No Jotform contracts assigned.</p> : (
            <div className="mb-4 overflow-x-auto">
              <table className="w-full min-w-[620px] text-sm">
                <thead className="text-left text-slate-700"><tr><th className="py-1 pr-3">Client</th><th className="pr-3">Contract</th><th className="pr-3">Status</th><th className="pr-3">Assigned</th><th className="pr-3">Due</th><th>Form</th></tr></thead>
                <tbody className="divide-y divide-navy-100">
                  {jotform.map((c) => (
                    <tr key={c.id} data-testid="jotform-row">
                      <td className="py-2 pr-3"><Link className="underline" href={`/clients/${c.client.id}?tab=services`}>{c.client.displayName}</Link></td>
                      <td className="pr-3 font-medium">{c.title}{c.pdfDocument && <span className="block text-xs text-slate-600">PDF: {c.pdfDocument.title}</span>}</td>
                      <td className="pr-3"><Badge tone={c.status === "COMPLETED" ? "green" : c.status === "CANCELLED" ? "gray" : "amber"}>{c.status === "ASSIGNED" ? "Waiting for client" : c.status.charAt(0) + c.status.slice(1).toLowerCase()}</Badge></td>
                      <td className="pr-3 whitespace-nowrap">{fmtDate(c.createdAt)}</td>
                      <td className="pr-3 whitespace-nowrap">{c.dueAt ? fmtDate(c.dueAt) : "—"}</td>
                      <td><a className="text-xs underline" href={contractFormUrl(c)} target="_blank" rel="noopener">Form {c.jotformFormId}</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-sm font-semibold text-navy-900 underline">Assign a Jotform contract</summary>
            <ActionForm action={assignJotformAction} className="mt-3 grid gap-2 sm:grid-cols-2" resetOnSuccess>
              <Field label="Client">
                <select className="input" name="clientId" required defaultValue=""><option value="" disabled>Choose a client</option>{allClients.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}</select>
              </Field>
              <Field label="Contract name"><input className="input" name="title" required placeholder="Bookkeeping engagement letter" /></Field>
              <Field label="Jotform form ID" hint="The number in the form's URL."><input className="input" name="formId" required inputMode="numeric" /></Field>
              <Field label="Due"><input className="input" type="date" name="dueAt" /></Field>
              <div className="sm:col-span-2"><Button type="submit">Assign Jotform contract</Button></div>
              <p className="text-xs text-slate-600 sm:col-span-2">Add a hidden field named <code>assignment_ref</code> to the Jotform form so submissions can be matched to this client. Jotform contracts are not used for tax-return signatures.</p>
            </ActionForm>
          </details>
        </div>
      </Card>
    </>
  );
}
