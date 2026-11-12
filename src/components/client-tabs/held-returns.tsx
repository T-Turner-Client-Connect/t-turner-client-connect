import type { Actor } from "@/lib/auth/actor";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field } from "@/components/ui";
import { canReviewHolds, heldReturns } from "@/lib/services/return-gate";
import { discardHeldReturnAction, verifyHeldReturnAction } from "@/app/actions/return-gate";
import { fmtDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

/**
 * Returns that couldn't be verified at upload. They are NOT in the client's records; Tabitha or an
 * Admin opens the file, types what is printed on it, and it is accepted only if that is this client
 * and year. A positive mismatch never reaches this list — it is rejected at upload.
 */
export async function HeldReturns({ clientId, user }: { clientId: string; user: Actor }) {
  const holds = await heldReturns(clientId);
  if (!holds.length) return null;
  const reviewer = canReviewHolds(user);
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { clientType: true } });
  const business = client?.clientType !== "INDIVIDUAL";
  return (
    <div id="held-returns">
      <Card title="Returns held for verification">
        <p className="text-sm text-slate-600">These uploads couldn&apos;t be verified, so they are not in this client&apos;s records. {reviewer ? "Open the file and enter what is printed on it. It is accepted only if it is this client and this year; then upload it again where it was uploaded." : "Tabitha or an Admin verifies them."} Held files are deleted after 7 days.</p>
        <ul className="mt-3 divide-y divide-ivory-200" data-testid="held-returns">
          {holds.map((h) => {
            const reasons = (h.reasons as { code: string; message: string }[]) ?? [];
            return (
              <li key={h.id} className="py-3 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <strong>{h.taxYear} {h.jurisdiction === "FEDERAL" ? "Federal" : h.jurisdiction === "ANY" ? "tax" : h.jurisdiction} {h.returnType ?? ""} {h.filingType === "AMENDED" ? "(amended)" : ""} return</strong>
                  <Badge tone="amber">Held</Badge>
                  <span className="text-xs text-slate-500">uploaded {fmtDateTime(h.createdAt)}</span>
                </p>
                <ul className="ml-4 mt-1 list-disc text-slate-700">{reasons.map((r, i) => <li key={i}>{r.message}</li>)}</ul>
                {reviewer && (
                  <div className="mt-2 space-y-2">
                    <a className="text-sm underline" href={`/api/tax/held-return/${h.id}`} target="_blank" rel="noopener noreferrer">Open the held file</a>
                    <ActionForm action={verifyHeldReturnAction.bind(null, clientId, h.id)} className="grid gap-2 sm:grid-cols-3">
                      <Field label="Tax year printed on the return"><input className="input" name="year" inputMode="numeric" required /></Field>
                      {business ? (
                        <>
                          <Field label="Name printed on the return"><input className="input" name="businessName" required /></Field>
                          <Field label="EIN printed on the return"><input className="input" name="ein" placeholder="12-3456789" required /></Field>
                        </>
                      ) : (
                        <>
                          <Field label="Taxpayer first name as printed"><input className="input" name="first" required /></Field>
                          <Field label="Taxpayer last name as printed"><input className="input" name="last" required /></Field>
                          <label className="flex items-center gap-2 sm:col-span-3"><input type="checkbox" name="nameChange" /> This is the client&apos;s legal name change, nickname or initial (it will be remembered for this client)</label>
                        </>
                      )}
                      <Field label="How you verified it" className="sm:col-span-3"><input className="input" name="note" placeholder="e.g. Compared name, SSN last 4 and year with the client record" required /></Field>
                      <div><Button type="submit">Verify match</Button></div>
                    </ActionForm>
                    <ActionForm action={discardHeldReturnAction.bind(null, clientId, h.id)} className="flex flex-wrap items-end gap-2">
                      <Field label="Remove instead — why?"><input className="input" name="reason" placeholder="Wrong file" required /></Field>
                      <Button type="submit" variant="secondary">Remove held file</Button>
                    </ActionForm>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
