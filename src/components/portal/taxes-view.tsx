import type { loadPortalTaxes } from "@/lib/portal/tax-view";
import { Badge, Card, EmptyState } from "@/components/ui";
import { AMENDMENT_LABELS, filingStatusLabel, jurisdictionLabel } from "@/lib/tax/normalize";
import { SIGNATURE_LABELS } from "@/lib/services/signatures";
import { fmtDate } from "@/lib/format";

type Data = Awaited<ReturnType<typeof loadPortalTaxes>>;

const PREP_PLAIN = {
  AWAITING_INFORMATION: "We need information from you",
  IN_PROGRESS: "We're preparing it",
  UNDER_REVIEW: "Under review",
  AWAITING_SIGNATURE: "Waiting for your signature",
  READY_TO_FILE: "Ready to file",
} as const;
const DOC_LABEL: Record<string, string> = { OFFICIAL_ACK: "Official acknowledgment", AGENCY_NOTICE: "Notice from the agency", CORRESPONDENCE: "Correspondence" };

export function PortalTaxesView({ data, linkFor }: { data: Data; linkFor: (id: string) => string }) {
  if (!data.years.length && !data.requests.length) return <EmptyState title="No tax filings yet">Your return progress and filing updates will appear here, by tax year.</EmptyState>;
  return (
    <div className="space-y-6">
      {data.requests.length > 0 && (
        <Card title="Information we need from you">
          <ul className="space-y-1 text-sm">{data.requests.map((r) => <li key={r.id}><strong>{r.title}</strong>{r.dueAt && ` — by ${fmtDate(r.dueAt)}`}</li>)}</ul>
        </Card>
      )}
      {data.years.map((year) => {
        const filings = data.filings.filter((f) => f.taxYear === year);
        const sigs = data.signatures.filter((s) => s.taxYear === year);
        const groups = [
          ["Your return", filings.filter((f) => f.filingType === "ORIGINAL")],
          ["Extension", filings.filter((f) => f.filingType === "EXTENSION")],
          ["Amended return", filings.filter((f) => f.filingType === "AMENDED")],
        ] as const;
        return (
          <section key={year} className="space-y-3">
            <h2 className="text-2xl font-semibold">{year} tax year</h2>
            {groups.filter(([, list]) => list.length).map(([label, list]) => (
              <Card key={label} title={label}>
                <ul className="space-y-4">
                  {list.map((f) => {
                    const status = filingStatusLabel(f);
                    return (
                      <li key={f.id} className="rounded-xl border border-ivory-200 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="font-semibold text-navy-900">{jurisdictionLabel(f.jurisdiction)} — Form {f.returnType}</p>
                            {f.filingType === "ORIGINAL" && f.filingStatus === "NOT_SUBMITTED" && <p className="text-sm text-slate-600">Progress: {PREP_PLAIN[f.prepStatus]}</p>}
                            {f.submittedAt && <p className="text-sm text-slate-600">{f.method === "PAPER" ? "Mailed" : "Submitted"} {fmtDate(f.submittedAt)}</p>}
                          </div>
                          <Badge tone={f.filingStatus === "ACCEPTED" ? "green" : f.filingStatus === "REJECTED" ? "red" : "gray"}>{status}</Badge>
                        </div>
                        {f.filingStatus === "REJECTED" && <p className="mt-2 text-sm text-red-800">This filing needs a correction. We&apos;ll contact you — no action is needed unless we ask.</p>}
                        {f.filingType === "EXTENSION" && f.filingStatus === "ACCEPTED" && (
                          <p className="mt-2 text-sm text-slate-700">Your extension was accepted. This extends the time to file — it is not acceptance of your completed return.</p>
                        )}
                        {f.filingType === "AMENDED" && f.filingStatus === "ACCEPTED" && (
                          <p className="mt-2 text-sm text-slate-700">
                            Accepted for processing means the agency received it; it doesn&apos;t yet mean the changes were approved or a refund issued.
                            {f.amendmentOutcome !== "NONE" && <> Latest: <strong>{AMENDMENT_LABELS[f.amendmentOutcome]}</strong>.</>}
                          </p>
                        )}
                        {f.documents.length > 0 && (
                          <ul className="mt-3 space-y-1 text-sm">
                            {f.documents.map((d) => (
                              <li key={d.id}>
                                📄 <a className="underline" href={linkFor(d.id)} target="_blank" rel="noopener">{d.title}</a>{" "}
                                <span className="text-xs text-slate-500">{DOC_LABEL[d.filingDocType ?? ""] ?? "Document"}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {f.filingStatus === "ACCEPTED" && (
                          <p className="mt-2 text-xs text-slate-500">
                            Status above is our summary
                            {f.documents.some((d) => d.filingDocType === "OFFICIAL_ACK") ? "; the official acknowledgment is attached." : ", based on our verification of the agency's acknowledgment."}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            ))}
            {sigs.length > 0 && (
              <Card title="Signatures">
                <ul className="text-sm">{sigs.map((s) => <li key={s.id}>{s.title} — {SIGNATURE_LABELS[s.status]}</li>)}</ul>
              </Card>
            )}
          </section>
        );
      })}
    </div>
  );
}
