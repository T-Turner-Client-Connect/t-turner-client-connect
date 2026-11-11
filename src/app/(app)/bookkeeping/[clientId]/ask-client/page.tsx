import Image from "next/image";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, Notice, PageHeader } from "@/components/ui";
import { addAskItemAction, editAskItemAction, removeAskItemAction, sendAskItemsAction } from "@/app/actions/ask-client";
import { ASK_CLIENT_ON_HOLD, askClientView } from "@/lib/services/ask-client";
import { BK_PORTAL_COETHA_V1 } from "@/lib/client-letters/templates";
import { downloadToken } from "@/lib/services/documents";
import { canSendClientRequests } from "@/lib/services/bk-permissions";
import { registryLabel } from "@/lib/services/bank-accounts";
import { rangeText } from "@/lib/services/client-requests";

export const metadata = { title: "Ask Client" };

const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const READING: Record<string, string> = { QUEUED: "Coetha will read it shortly", READING: "Coetha is reading it", DONE: "Read by Coetha", FAILED: "Coetha couldn't read it (try again on Ask Coetha)" };

export default async function AskClientPage({ params }: { params: Promise<{ clientId: string }> }) {
  await connection();
  const user = await requireUser();
  const { clientId } = await params;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { displayName: true, businessName: true } });
  if (!client) notFound();
  if (!(await canSendClientRequests(user, clientId))) {
    return <Notice tone="warn">Only Admins, the staff member assigned to this business and staff Tabitha allows can prepare its client requests.</Notice>;
  }
  const v = await askClientView(user, clientId);
  const business = client.businessName || client.displayName;
  const base = `/bookkeeping/${clientId}`;
  const link = (id: string) => `/api/documents/${downloadToken(id, { staffId: user.id })}`;
  const lh = BK_PORTAL_COETHA_V1.letterhead;
  type Item = (typeof v.drafts)[number];

  const editForm = (r: Item) => (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs font-semibold text-navy-700">Edit</summary>
      <ActionForm action={editAskItemAction.bind(null, clientId, r.id)} className="mt-2 grid gap-2 sm:grid-cols-2">
        <Field label="What we need" className="sm:col-span-2"><input name="title" className="input" defaultValue={r.title} required maxLength={200} /></Field>
        <Field label="Why we need it" className="sm:col-span-2"><textarea name="reason" className="input" rows={2} defaultValue={r.reason ?? ""} maxLength={500} /></Field>
        <Field label="Instructions (optional)"><input name="instructions" className="input" defaultValue={r.instructions ?? ""} maxLength={1000} /></Field>
        <Field label="Respond by (optional)"><input type="date" name="dueAt" className="input" defaultValue={r.dueAt?.toISOString().slice(0, 10) ?? ""} /></Field>
        <div><Button type="submit" variant="secondary">Save</Button></div>
      </ActionForm>
    </details>
  );
  const itemText = (r: Item) => (
    <>
      <p className="font-semibold text-navy-900">{r.title} {r.source === "COETHA" && <Badge tone="gold">Prepared by Coetha</Badge>} {r.routing === "REVIEW" && <Badge tone="amber">Tabitha reviews</Badge>}</p>
      {(r.bookkeepingAccount || r.periodStart) && <p className="text-xs text-slate-600">{r.bookkeepingAccount ? `Account: ${registryLabel(r.bookkeepingAccount)}` : ""}{r.bookkeepingAccount && r.periodStart ? " · " : ""}{r.periodStart ? `Period: ${rangeText(r)}` : ""}</p>}
      {r.reason && <p className="text-sm text-slate-700">{r.reason}</p>}
      {r.instructions && <p className="text-sm text-slate-600">{r.instructions}</p>}
      {r.dueAt && <p className="text-xs text-slate-500">Respond by {fmt(r.dueAt)}</p>}
    </>
  );

  return (
    <>
      <PageHeader
        title="Ask Client"
        subtitle={<>Supporting documents and explanations only <strong>{business}</strong> can give. Coetha prepares the list; you review it before anything is sent.</>}
        actions={<Link href={`${base}/audit-file`} className="rounded-full border border-navy-900 px-4 py-2 text-sm font-semibold text-navy-900" data-testid="audit-file-link">Audit File</Link>}
      />
      {!v.rolloutAuthorized && <div className="mb-4"><Notice tone="warn" title="Client communications are on hold">{ASK_CLIENT_ON_HOLD} You can still prepare, edit and print the request letter.</Notice></div>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title={`Draft requests (${v.drafts.length})`} actions={v.drafts.length + v.waiting.length > 0 ? <a href={`/api/bookkeeping/${clientId}/ask-client/letter`} className="rounded-full bg-navy-900 px-4 py-2 text-sm font-semibold text-white" data-testid="ask-letter">Request letter (PDF)</a> : null}>
            {v.drafts.length ? (
              <>
                <ul className="divide-y divide-ivory-200" data-testid="ask-drafts">
                  {v.drafts.map((r) => (
                    <li key={r.id} className="py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">{itemText(r)}</div>
                        <ActionForm action={removeAskItemAction.bind(null, clientId, r.id)}><Button type="submit" variant="ghost">Remove</Button></ActionForm>
                      </div>
                      {editForm(r)}
                    </li>
                  ))}
                </ul>
                <ActionForm action={sendAskItemsAction.bind(null, clientId)} className="mt-4 border-t border-ivory-200 pt-4">
                  {v.drafts.map((r) => <input key={r.id} type="hidden" name="ids" value={r.id} />)}
                  <Button type="submit" disabled={!v.rolloutAuthorized} data-testid="ask-send">Send all drafts to the client</Button>
                  <p className="mt-2 text-xs text-slate-600">{v.rolloutAuthorized ? "Each item appears in the client's portal under Bookkeeping & requests, with the client's usual notice." : "Sending unlocks only after Tabitha authorizes client communications and rollout."}</p>
                </ActionForm>
              </>
            ) : (
              <EmptyState title="No drafts">Ask Coetha what she needs from the client, or add an item below.</EmptyState>
            )}
          </Card>

          <Card title={`Sent, waiting on the client (${v.waiting.length})`}>
            {v.waiting.length ? (
              <ul className="divide-y divide-ivory-200" data-testid="ask-waiting">
                {v.waiting.map((r) => (
                  <li key={r.id} className="py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">{itemText(r)}<p className="text-xs text-slate-500">Sent {r.sentAt ? fmt(r.sentAt) : ""}</p></div>
                      <ActionForm action={removeAskItemAction.bind(null, clientId, r.id)}><Button type="submit" variant="ghost">Withdraw</Button></ActionForm>
                    </div>
                    {editForm(r)}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-slate-600">Nothing is waiting on the client.</p>}
          </Card>

          <Card title={`Client responses (${v.answered.length})`}>
            {v.answered.length ? (
              <ul className="divide-y divide-ivory-200" data-testid="ask-answered">
                {v.answered.map((r) => (
                  <li key={r.id} className="py-3">
                    <p className="font-semibold text-navy-900">{r.title}</p>
                    {r.clientExplanation && (
                      <div className="mt-2 rounded-lg border border-ivory-200 bg-ivory-50 p-3 text-sm">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Client&apos;s explanation{r.explainedAt ? ` · ${fmt(r.explainedAt)}` : ""}</p>
                        <p className="mt-1 whitespace-pre-wrap text-slate-800" data-testid="ask-explanation">{r.clientExplanation}</p>
                        <p className="mt-2 text-xs text-amber-800">Evidence only. It doesn&apos;t authorize an entry by itself.</p>
                      </div>
                    )}
                    {r.documents.length > 0 && (
                      <ul className="mt-2 space-y-1 text-sm">
                        {r.documents.map((d) => (
                          <li key={d.id} className="flex flex-wrap items-center gap-2">
                            {d.scanStatus === "CLEAN" ? <a className="font-semibold text-navy-700 underline" href={link(d.id)} target="_blank" rel="noreferrer">{d.title}</a> : <span className="font-semibold">{d.title}</span>}
                            <span className="text-xs text-slate-500">{fmt(d.createdAt)}</span>
                            {d.scanStatus !== "CLEAN" && <Badge tone="amber">Virus scan: {d.scanStatus.toLowerCase().replace("_", " ")}</Badge>}
                            {v.reading[d.id] && <Badge tone={v.reading[d.id] === "DONE" ? "green" : v.reading[d.id] === "FAILED" ? "red" : "gray"}>{READING[v.reading[d.id]] ?? v.reading[d.id]}</Badge>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-slate-600">No responses yet.</p>}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Letterhead">
            <div className="flex items-center gap-3 border-b-2 border-gold-500 pb-3" data-testid="ask-letterhead">
              <Image src="/brand/logo-mark.png" alt="" width={40} height={40} />
              <div>
                <p className="font-serif text-base font-bold text-navy-900">{lh.name}</p>
                <p className="text-xs text-slate-600">{lh.lines.join(" · ")}</p>
              </div>
            </div>
            <p className="mt-3 text-sm text-slate-600">The request letter lists every draft and sent item on this letterhead, and tells the client how to upload each document or write an explanation in Client Connect.</p>
          </Card>
          <Card title="Add an item">
            <ActionForm action={addAskItemAction.bind(null, clientId)} className="space-y-3" resetOnSuccess>
              <Field label="What we need"><input name="title" className="input" required maxLength={200} placeholder="Receipt for check #1043, $412.00 (March 4)" /></Field>
              <Field label="Why we need it"><textarea name="reason" className="input" rows={2} maxLength={500} placeholder="To record it to the right expense account." /></Field>
              <Field label="Instructions (optional)"><input name="instructions" className="input" maxLength={1000} placeholder="A photo is fine. No document? A short explanation is fine." /></Field>
              <Field label="Respond by (optional)"><input type="date" name="dueAt" className="input" /></Field>
              <Button type="submit" variant="secondary">Add to drafts</Button>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  );
}
