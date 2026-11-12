import Link from "next/link";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, PageHeader } from "@/components/ui";
import { noticeStatusAction } from "@/app/actions/notices";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { staffOpenAuditAction } from "@/app/actions/audit-center";
import { AUDIT_KINDS, AUDIT_STATUS, auditList } from "@/lib/services/audit-center";
import { Field } from "@/components/ui";
import { AGENCIES, deadlineFlag, NOTICE_STATUS, openNoticeCases } from "@/lib/services/notices";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Audit Center" };

/** Open audit and tax-notice cases across clients, soonest response deadline first. */
export default async function NoticesPage() {
  await connection();
  const actor = await requireUser();
  const cases = (await openNoticeCases()).filter((c) => !(c as { auditKind?: string | null }).auditKind);
  const audits = await auditList(actor);
  const clients = await prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" }, take: 2000 });
  const thisYear = new Date().getFullYear();
  return (
    <>
      <PageHeader title="Audit Center" subtitle="Federal and state audits: the items under examination, documents received, missing and verified, Coetha's progress and the audit package. Other agency notices are listed below." />
      <Card title={`Audits (${audits.length})`} className="mb-4">
        {audits.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm" data-testid="audit-list">
              <thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-2">Client</th><th>Audit</th><th>Items examined</th><th>Documents</th><th>Status</th><th>Deadline</th></tr></thead>
              <tbody>
                {audits.map((a) => {
                  const flag = deadlineFlag({ responseDueOn: a.responseDueOn, status: a.status === "CLOSED" ? "CLOSED" : "UNDER_REVIEW" });
                  return (
                    <tr key={a.id} className="border-t border-ivory-200 align-top">
                      <td className="py-2"><Link className="font-semibold underline" href={`/notices/${a.id}`}>{a.client.displayName}</Link></td>
                      <td>{a.kind === "FEDERAL" ? "Federal" : `State (${a.stateCode})`} · {a.taxYear}</td>
                      <td className="text-xs">{a.items.length ? a.items.join("; ") : "Not identified yet"}</td>
                      <td className="text-xs">{a.received} received · {a.verified} verified · {a.missing} missing</td>
                      <td><Badge tone={a.status === "DISCREPANCY" ? "red" : a.status === "WAITING_ON_DOCUMENTS" ? "amber" : a.status === "CLOSED" ? "gray" : "navy"}>{AUDIT_STATUS[a.status]}</Badge>{a.packageReady && <span className="block text-xs text-emerald-700">Package built</span>}</td>
                      <td className="text-xs">{a.responseDueOn ? fmtDate(a.responseDueOn) : "Unknown"}{flag && <Badge tone={flag.tone} className="mt-1 block">{flag.text}</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-slate-600">No audits.</p>}
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-navy-700">Open an audit for a client (a notice that came to the office)</summary>
          <ActionForm action={staffOpenAuditAction.bind(null, "")} className="mt-2 grid gap-2 sm:grid-cols-3">
            <Field label="Client"><select className="input" name="clientId" required defaultValue=""><option value="" disabled>Choose</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}</select></Field>
            <Field label="Audit"><select className="input" name="kind">{Object.entries(AUDIT_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="State (state audits)"><input className="input" name="stateCode" maxLength={2} placeholder="AL" /></Field>
            <Field label="Tax year"><input className="input" name="taxYear" type="number" required defaultValue={thisYear - 1} /></Field>
            <Field label="Response deadline"><input className="input" type="date" name="responseDueOn" /></Field>
            <Field label="Notice (PDF or photos)"><input className="input" type="file" name="file" multiple accept="application/pdf,image/*" /></Field>
            <div><Button type="submit">Open audit</Button></div>
          </ActionForm>
        </details>
      </Card>
      <h2 className="mb-2 font-serif text-lg font-bold text-navy-900">Other notices</h2>
      {cases.length === 0 ? (
        <EmptyState title="No open notices" />
      ) : (
        <Card>
          <ul className="divide-y divide-navy-100 text-sm" data-testid="notice-cases">
            {cases.map((c) => {
              const flag = deadlineFlag(c);
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <span>
                    <Link className="font-semibold underline" href={`/clients/${c.client.id}?tab=documents`}>{c.client.displayName}</Link> · {AGENCIES[c.agency as keyof typeof AGENCIES]}{c.agencyDetail && ` (${c.agencyDetail})`} · tax year {c.taxYear ?? "not sure"} · {c.documents.length} file{c.documents.length === 1 ? "" : "s"}
                    <span className="block text-xs text-slate-600">Uploaded {fmtDateTime(c.createdAt)}{c.receivedOn && ` · received by client ${fmtDate(c.receivedOn)}`}{c.clientMessage && ` · “${c.clientMessage.slice(0, 120)}”`}</span>
                    {flag ? <Badge tone={flag.tone} className="mt-1">{flag.text}</Badge> : !c.responseDueOn && <Badge tone="amber" className="mt-1">Deadline unknown — check the letter</Badge>}
                  </span>
                  <ActionForm action={noticeStatusAction.bind(null, c.id)} className="flex items-center gap-2" showSuccess={false}>
                    <select className="input w-auto" name="status" defaultValue={c.status} aria-label="Status">{Object.entries(NOTICE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
                    <Button type="submit" variant="secondary">Save</Button>
                  </ActionForm>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
