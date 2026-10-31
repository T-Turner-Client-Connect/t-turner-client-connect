import Link from "next/link";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, PageHeader } from "@/components/ui";
import { ReturnFields } from "@/components/return-fields";
import { bulkReturnsAction, confirmIntakeAction, discardIntakeAction, returnStepAction } from "@/app/actions/tax-returns";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { filingLabel, RETURN_COPY_STATUS, returnsQueue } from "@/lib/services/tax-returns";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Tax returns" };

export default async function TaxReturnsPage() {
  await connection();
  const user = await requireUser();
  const [q, approver, clients] = await Promise.all([
    returnsQueue(),
    isReportApprover(user),
    prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true, businessName: true }, orderBy: { displayName: "asc" } }),
  ]);
  const options = clients.map((c) => ({ id: c.id, name: c.businessName && c.businessName !== c.displayName ? `${c.businessName} (${c.displayName})` : c.displayName }));
  const ready = q.drafts.filter((d) => d.reviewStatus === "AWAITING_REVIEW");
  const drafts = q.drafts.filter((d) => d.reviewStatus === "DRAFT");

  return (
    <>
      <PageHeader title="Tax returns" subtitle="Completed returns from TaxAct: upload, confirm where each belongs, then Tabitha releases each copy to the client's portal." />
      <Card title="Upload completed returns (several at once)" className="mb-4">
        <ActionForm action={bulkReturnsAction} className="flex flex-wrap items-end gap-2" resetOnSuccess>
          <Field label="Return PDFs (up to 50)"><input className="input" type="file" name="files" multiple accept="application/pdf" required /></Field>
          <Button type="submit">Add to review queue</Button>
        </ActionForm>
        <p className="mt-2 text-xs text-slate-600">Nothing goes to a client from here. Each file waits below until you confirm the client, tax year, return type and federal/state. Suggestions come from file names only and are never applied automatically. The same file is never queued or filed twice.</p>
      </Card>

      <Card title={`Review queue — ${q.intakes.length}`} className="mb-4">
        {q.intakes.length === 0 ? <EmptyState title="Nothing waiting">Uploaded returns appear here for confirmation.</EmptyState> : (
          <ul className="divide-y divide-ivory-200" data-testid="intake-queue">
            {q.intakes.map((i) => (
              <li key={i.id} className="py-3" data-file={i.originalName}>
                <p className="text-sm"><strong>{i.originalName}</strong> · uploaded {fmtDateTime(i.createdAt)}</p>
                <p className="text-xs text-slate-600" data-testid="intake-suggestion">{i.suggested ? <>Suggested: <strong>{i.suggested.businessName || i.suggested.displayName}</strong> — {i.matchReason}. Confirm or change it.</> : <>No suggestion — {i.matchReason}. Choose the client.</>}</p>
                <ActionForm action={confirmIntakeAction.bind(null, i.id)} className="mt-2 grid gap-2 sm:grid-cols-6">
                  <ReturnFields clients={options} clientId={i.suggestedClientId} year={i.suggestedYear} type={i.suggestedType} />
                  <div className="flex items-end"><Button type="submit" variant="secondary">Confirm &amp; file</Button></div>
                </ActionForm>
                <ActionForm action={discardIntakeAction.bind(null, i.id)} className="mt-1 flex flex-wrap items-end gap-2">
                  <input className="input w-64" name="reason" placeholder="Why remove it? (e.g. wrong file)" aria-label="Reason" />
                  <Button type="submit" variant="ghost">Remove from queue</Button>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Ready for Tabitha — ${ready.length}`}>
          <ul className="divide-y divide-ivory-200 text-sm" data-testid="ready-list">
            {ready.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><Link className="underline" href={`/clients/${d.client.id}?tab=taxes`}>{d.title}</Link> · {d.client.businessName || d.client.displayName}{d.version && d.version > 1 ? ` · version ${d.version}` : ""}</span>
                {approver ? (
                  <ActionForm action={returnStepAction.bind(null, d.id, "release")}><Button type="submit" variant="gold" disabled={d.scanStatus !== "CLEAN"}>Release to client</Button></ActionForm>
                ) : <Badge tone="gold">Waiting for Tabitha</Badge>}
              </li>
            ))}
            {ready.length === 0 && <li className="py-2 text-slate-600">None.</li>}
          </ul>
        </Card>
        <Card title={`Drafts — ${drafts.length}`}>
          <ul className="divide-y divide-ivory-200 text-sm" data-testid="draft-list">
            {drafts.map((d) => {
              const fl = filingLabel(d.filing?.filingStatus);
              return (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><Link className="underline" href={`/clients/${d.client.id}?tab=taxes`}>{d.title}</Link> · {d.client.businessName || d.client.displayName} <Badge tone="gray">{RETURN_COPY_STATUS.DRAFT.label}</Badge>{fl && <Badge tone={fl.tone} className="ml-1">{fl.label}</Badge>}</span>
                  <ActionForm action={returnStepAction.bind(null, d.id, "submit")}><Button type="submit" variant="secondary" disabled={d.scanStatus !== "CLEAN"}>Send for review</Button></ActionForm>
                </li>
              );
            })}
            {drafts.length === 0 && <li className="py-2 text-slate-600">None.</li>}
          </ul>
        </Card>
      </div>
      <p className="mt-4 text-xs text-slate-600">“Accepted Return” appears only when the filing record shows Accepted with the acknowledgment or a described verification. Uploading a PDF never marks a return accepted.</p>
    </>
  );
}
