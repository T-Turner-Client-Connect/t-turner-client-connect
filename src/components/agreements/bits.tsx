import { ActionForm } from "@/components/action-form";
import { Badge, Button, Notice } from "@/components/ui";
import { dismissAttorneyNoteAction } from "@/app/actions/agreements";
import { STATUS_LABELS, type DisplayStatus, type Rendered } from "@/lib/agreements/catalog";

const TONE: Record<DisplayStatus, "gray" | "amber" | "green" | "red" | "gold" | "navy"> = {
  DRAFT: "gray",
  WAITING_FOR_OWNER: "gold",
  SENT: "amber",
  SIGNED: "green",
  DECLINED: "red",
  EXPIRED: "gray",
  VOID: "gray",
  RENEWAL_DUE: "gold",
};

export function StatusBadge({ status }: { status: DisplayStatus }) {
  return <span data-testid="agreement-status"><Badge tone={TONE[status]}>{STATUS_LABELS[status]}</Badge></span>;
}

/** Shown to Tabitha once, until she dismisses it. */
export function AttorneyNote() {
  return (
    <Notice tone="info" title="Before you rely on these templates">
      <p>The clauses copied from your Jotform agreement are approved as written. Every other clause is plain-English wording drafted for you and marked DRAFT until you approve it. We recommend having your attorney review the templates before you use them with clients.</p>
      <ActionForm action={dismissAttorneyNoteAction} className="mt-2" showSuccess={false}><Button type="submit" variant="secondary">Got it — don&apos;t show again</Button></ActionForm>
    </Notice>
  );
}

/** The agreement text, read-only (detail page, portal, signing link). */
export function AgreementText({ r, checkboxes = false }: { r: Pick<Rendered, "title" | "intro" | "clauses" | "questions">; checkboxes?: boolean }) {
  return (
    <div data-testid="agreement-text">
      <h2 className="font-serif text-xl font-bold text-navy-900 sm:text-2xl">{r.title}</h2>
      <p className="mt-2 text-base text-slate-900">{r.intro}</p>
      <ol className="mt-4 space-y-4">
        {r.clauses.map((c, i) => (
          <li key={c.key} className="text-base text-slate-900">
            {checkboxes && c.kind === "ACK" ? (
              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-navy-100 bg-white p-3">
                <input type="checkbox" name="ack" value={c.key} required className="mt-1 size-6 shrink-0 accent-navy-900" data-testid="ack" />
                <span><span className="font-semibold text-navy-900">{i + 1}. {c.title}.</span> {c.text}</span>
              </label>
            ) : (
              <>
                <p className="font-semibold text-navy-900">{i + 1}. {c.kind === "ACK" && !checkboxes ? "☐ " : ""}{c.title}{"status" in c && c.status !== "APPROVED" && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-900">DRAFT — needs Tabitha&apos;s approval</span>}</p>
                <p className="whitespace-pre-wrap">{c.text}</p>
              </>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
