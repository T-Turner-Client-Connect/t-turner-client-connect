import clsx from "clsx";
import { ActionForm } from "@/components/action-form";
import { docTypeLabel, rangeText, REQUEST_STATUS_LABEL } from "@/lib/services/client-requests";
import { registryLabel } from "@/lib/services/bank-accounts";
import { answerRequestYourselfAction, closeRequestAction, discardRequestAction, sendRequestAction } from "@/app/actions/bk-workflow";
import { navyBtn, outlineBtn } from "./parts";

type Req = {
  id: string; title: string; status: string; kind: string; source: string; reason: string | null; routing?: string | null; routingReason?: string | null; docType: string | null; periodStart: Date | null; periodEnd: Date | null; dueAt: Date | null; createdAt: Date; sentAt: Date | null;
  bookkeepingAccount: { institution: string; nickname: string | null; last4: string | null; accountType: string } | null; _count?: { documents: number }; clientExplanation?: string | null; officeAnswer?: string | null;
};
const review = (r: { status: string; routing?: string | null }) => r.status === "DRAFT" && r.routing === "REVIEW";
const TONE: Record<string, string> = { DRAFT: "bg-slate-100 text-slate-700", OPEN: "bg-amber-50 text-amber-800", SUBMITTED: "bg-gold-100 text-gold-800", ACCEPTED: "bg-emerald-50 text-emerald-800" };

/** One request line: the exact document, account, period and reason; drafts get one-click Send. */
export function RequestList({ items, clientId, canSend, canApprove = false, empty }: { items: Req[]; clientId: string; canSend: boolean; canApprove?: boolean; empty: string }) {
  if (!items.length) return <p className="mt-2 text-sm text-slate-600">{empty}</p>;
  return (
    <ul className="mt-2 divide-y divide-ivory-200" data-testid="request-list">
      {items.map((r) => (
        <li key={r.id} className="py-2.5" data-testid="request" data-status={r.status}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold text-navy-900">{r.title}</p>
              <p className="text-xs text-slate-600">
                {docTypeLabel(r.docType) ?? "Document"}
                {r.bookkeepingAccount ? ` · ${registryLabel(r.bookkeepingAccount)}` : ""}
                {rangeText(r) ? ` · ${rangeText(r)}` : ""}
                {r.source === "COETHA" ? " · prepared by Coetha" : ""}
                {r._count?.documents ? ` · ${r._count.documents} file${r._count.documents === 1 ? "" : "s"} received` : ""}
              </p>
              {r.reason && <p className="mt-0.5 text-sm text-navy-800">{r.reason}</p>}
              {r.clientExplanation && <p className="mt-1 rounded-md bg-emerald-50 px-2 py-1 text-sm text-emerald-900" data-testid="client-answer-shown"><strong>Client&apos;s answer:</strong> {r.clientExplanation}</p>}
              {r.officeAnswer && <p className="mt-1 rounded-md bg-ivory-100 px-2 py-1 text-sm text-navy-900"><strong>Your answer:</strong> {r.officeAnswer}</p>}
            </div>
            <span className={clsx("shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold", review(r) ? "bg-gold-100 text-gold-800" : TONE[r.status] ?? "bg-slate-100")}>{review(r) ? REQUEST_STATUS_LABEL.REVIEW : REQUEST_STATUS_LABEL[r.status] ?? r.status}</span>
          </div>
          {review(r) && r.routingReason && <p className="mt-0.5 text-xs font-semibold text-gold-800" data-testid="routing-reason">Held for Tabitha: {r.routingReason}</p>}
          {r.routing === "ROUTINE" && r.status !== "DRAFT" && r.source === "COETHA" && <p className="mt-0.5 text-xs text-slate-500">Routine — sent automatically</p>}
          {canSend && r.status === "DRAFT" && (!review(r) || canApprove) && (
            <div className="mt-1.5 flex flex-wrap gap-2">
              <ActionForm action={sendRequestAction.bind(null, clientId, r.id)} showSuccess={false}><button type="submit" className={navyBtn} data-testid="send-request">Send to client</button></ActionForm>
              <ActionForm action={discardRequestAction.bind(null, clientId, r.id)} showSuccess={false}><button type="submit" className={outlineBtn}>Discard</button></ActionForm>
            </div>
          )}
          {canApprove && ["DRAFT", "OPEN", "SUBMITTED"].includes(r.status) && (
            <div className="mt-2" data-testid="answer-yourself"><ActionForm action={answerRequestYourselfAction.bind(null, clientId, r.id)} className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <label className="min-w-0 flex-1 text-sm">
                <span className="sr-only">Your answer</span>
                <textarea name="answer" required minLength={2} maxLength={2000} rows={2} className="input w-full" placeholder="Know the answer? Type it here (for example: owner draw, paid personally; or supplies for the office). Nothing goes to the client." />
              </label>
              <button type="submit" className={navyBtn}>Answer</button>
            </ActionForm></div>
          )}
          {canSend && (r.status === "OPEN" || r.status === "SUBMITTED") && (
            <div className="mt-1.5 flex flex-wrap gap-2" data-testid="close-request">
              <ActionForm action={closeRequestAction.bind(null, clientId, r.id, "received")} showSuccess={false}><button type="submit" className={outlineBtn}>Mark received</button></ActionForm>
              <ActionForm action={closeRequestAction.bind(null, clientId, r.id, "not_needed")} showSuccess={false} confirm="Close this request as not needed? It leaves the client's portal."><button type="submit" className={outlineBtn}>Close — not needed</button></ActionForm>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
