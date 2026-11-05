import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import { PresetReason } from "@/components/preset-reason";
import { confirmAcceptancesAction } from "@/app/actions/accepted-returns";
import { pendingAcceptances } from "@/lib/services/accepted-returns";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { filingTitle } from "@/lib/tax/normalize";

/**
 * "Ready for Tabitha to confirm acceptance": returns staff delivered through
 * the one-step form. Nothing is marked submitted until Tabitha confirms here
 * (Form 8879 checkbox, plus the reason when no approved summary is on file).
 */
export async function AcceptanceQueue({ approver, clientId, title = "Waiting for Tabitha to release" }: { approver: boolean; clientId?: string; title?: string }) {
  const items = await pendingAcceptances(clientId);
  if (clientId && !items.length) return null;
  const anyReason = items.some((i) => i.needsReason);
  return (
    <Card title={`${title} — ${items.length}`} className="mb-4">
      {items.length === 0 ? (
        <EmptyState title="Nothing waiting">Returns staff send with “Finish &amp; Send a Return” wait here for your confirmation.</EmptyState>
      ) : (
        <ActionForm action={confirmAcceptancesAction} className="space-y-3">
          <ul className="divide-y divide-ivory-200 text-sm" data-testid="acceptance-queue">
            {items.map((i) => (
              <li key={i.requestId} className="flex flex-wrap items-start gap-3 py-2">
                {approver && <input type="checkbox" name="filingId" value={i.filing.id} defaultChecked className="mt-1 accent-navy-900" aria-label={`Confirm ${filingTitle(i.filing)}`} />}
                <div className="min-w-0 flex-1">
                  <p>
                    <Link className="font-semibold underline" href={`/clients/${i.client.id}?tab=taxes`}>{i.client.businessName || i.client.displayName}</Link> · {filingTitle(i.filing)}
                    {i.needsReason && <Badge tone="gold" className="ml-1">No approved summary</Badge>}
                  </p>
                  <p className="text-xs text-slate-600">
                    Accepted {fmtDate(i.acceptedAt)}{i.submissionId ? ` · Submission ID ${i.submissionId}` : ""} · {i.hasAck ? "acknowledgment attached" : `“${i.verificationNote}”`} · entered by {i.requestedBy}, {fmtDateTime(i.requestedAt)}
                  </p>
                </div>
                {approver && <Button type="submit" name="only" value={i.filing.id} variant="secondary">Accept &amp; Send</Button>}
                <span className="flex items-center gap-1">
                  <input className="input w-40" name={`${i.filing.id}:reason`} placeholder="Why withdraw?" aria-label="Why withdraw?" />
                  <Button type="submit" name="withdraw" value={i.filing.id} variant="ghost">Withdraw</Button>
                </span>
              </li>
            ))}
          </ul>
          {approver ? (
            <div className="rounded-lg border border-gold-500/50 bg-gold-50 p-3 text-sm" data-testid="owner-confirm-box">
              <label className="flex items-start gap-2"><input type="checkbox" name="form8879" className="mt-1 accent-navy-900" /> Signed IRS Form 8879 (and any state e-file authorization) is on file for the returns I confirm.</label>
              {anyReason && <PresetReason className="mt-2" label="For returns with no client-approved summary — reason" />}
              <div className="mt-2"><Button type="submit" variant="gold">Mark checked Accepted &amp; Send to Client</Button></div>
            </div>
          ) : (
            <p className="text-xs text-slate-600">Only Tabitha confirms these. Her confirmation marks them Accepted and sends them to the client.</p>
          )}
        </ActionForm>
      )}
    </Card>
  );
}
