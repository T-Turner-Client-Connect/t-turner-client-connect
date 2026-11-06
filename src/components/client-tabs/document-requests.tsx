import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Button, Card, Field } from "@/components/ui";
import { requestDocumentAction, requestStatusAction } from "@/app/actions/workspace";
import { prisma } from "@/lib/prisma";
import { MONTHS } from "@/lib/services/bookkeeping";
import { fmtDate } from "@/lib/format";

const REQ_TONE = { DRAFT: "gray", OPEN: "amber", SUBMITTED: "gold", ACCEPTED: "green", CANCELLED: "gray" } as const;

/**
 * Document requests (Documents tab): every document asked of this client in
 * one list — tax, bookkeeping-month and other — with one "Request a document"
 * form. Monthly bookkeeping checklists still add month-tied requests from the
 * bookkeeping workspace; they show here too, labeled with their month.
 */
export async function DocumentRequestsCard({ clientId }: { clientId: string }) {
  const requests = await prisma.documentRequest.findMany({
    where: { clientId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { documents: true } }, period: { select: { year: true, month: true } } },
  });
  const open = requests.filter((r) => r.status === "OPEN" || r.status === "SUBMITTED" || r.status === "DRAFT");
  const closed = requests.filter((r) => !open.includes(r));

  const row = (r: (typeof requests)[number]) => (
    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <span>
        <span className="font-medium">{r.title}</span>
        <span className="text-slate-600"> · {r.period ? `Bookkeeping ${MONTHS[r.period.month - 1]} ${r.period.year}` : "Not tied to a month"}</span>
        {r.dueAt && <span className="text-slate-600"> · due {fmtDate(r.dueAt)}</span>}
        {r._count.documents > 0 && <span className="text-slate-600"> · {r._count.documents} file(s) received</span>}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <Badge tone={REQ_TONE[r.status]}>{r.status === "SUBMITTED" ? "Client uploaded — review" : r.status.charAt(0) + r.status.slice(1).toLowerCase()}</Badge>
        {r.status === "SUBMITTED" && (
          <>
            <ConfirmButton action={requestStatusAction.bind(null, clientId, r.id, "ACCEPTED")} variant="ghost">Accept</ConfirmButton>
            <ConfirmButton action={requestStatusAction.bind(null, clientId, r.id, "OPEN")} variant="ghost">Need more</ConfirmButton>
          </>
        )}
        {r.status === "OPEN" && <ConfirmButton action={requestStatusAction.bind(null, clientId, r.id, "CANCELLED")} variant="ghost" confirm="Cancel this request?">Cancel</ConfirmButton>}
      </span>
    </li>
  );

  return (
    <div id="requests">
      <Card title="Document requests">
        {open.length ? <ul className="divide-y divide-navy-100" data-testid="open-requests">{open.map(row)}</ul> : <p className="text-sm text-slate-600">Nothing requested right now.</p>}
        <details className="mt-2" open={open.length === 0}>
          <summary className="cursor-pointer text-sm font-semibold underline">Request a document</summary>
          <ActionForm action={requestDocumentAction.bind(null, clientId)} className="mt-2 grid gap-2 sm:grid-cols-2" resetOnSuccess>
            <input className="input sm:col-span-2" name="title" required placeholder="e.g. 2025 W-2 from your employer" aria-label="What you need" />
            <textarea className="input sm:col-span-2" name="instructions" rows={2} placeholder="Instructions (optional)" aria-label="Instructions" />
            <Field label="Due"><input className="input" type="date" name="dueAt" /></Field>
            <Field label="Reminder"><input className="input" type="date" name="remindAt" /></Field>
            <div><Button type="submit">Request</Button></div>
          </ActionForm>
        </details>
        {closed.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-sm text-slate-600">Completed and cancelled ({closed.length})</summary>
            <ul className="divide-y divide-navy-100">{closed.map(row)}</ul>
          </details>
        )}
      </Card>
    </div>
  );
}
