import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Notice } from "@/components/ui";
import { SummaryFigures, SummaryItems } from "@/components/tax-summary-view";
import { approveSummaryAction, requestSummaryChangesAction } from "@/app/actions/tax-summary";
import { previewFormAction } from "@/app/actions/preview";
import { PreviewOffNote } from "@/components/portal/preview-off";
import { consentText, NOT_8879, requiredRoles, type SummaryWithSigs } from "@/lib/services/tax-summary";
import { fmtDateTime } from "@/lib/format";
import { isAutoSummary } from "@/lib/services/auto-tax-summary";
import { AutoTaxSummaryView } from "./auto-tax-summary-view";

const CLIENT_STATUS = {
  SENT: { label: "Waiting for your approval", tone: "gold" },
  CHANGES_REQUESTED: { label: "On hold — our office is reviewing your changes", tone: "red" },
  CLIENT_APPROVED: { label: "Approved for filing", tone: "green" },
} as const;

/**
 * What the client sees: the key figures (not the full return) with
 * Approve for Filing / Request Changes. In the owner's View as Client the
 * same screen is shown with the buttons disabled.
 */
export function PortalSummaryView({ summaries, clientId, readOnly }: { summaries: SummaryWithSigs[]; clientId: string; readOnly?: boolean }) {
  if (!summaries.length) return <EmptyState title="Nothing to approve right now">When your return is prepared, we&apos;ll send you a short summary here to approve before we file.</EmptyState>;
  return (
    <div className="space-y-4" data-testid="portal-summaries">
      {summaries.map((s) => {
        // Read automatically from the prepared return: the plain-language page.
        if (isAutoSummary(s)) return <AutoTaxSummaryView key={s.id} s={s} clientId={clientId} readOnly={readOnly} />;
        const st = CLIENT_STATUS[s.status as keyof typeof CLIENT_STATUS];
        const signed = new Map(s.signatures.filter((g) => !g.invalidatedAt).map((g) => [g.role, g]));
        const roles = requiredRoles(s);
        return (
          <Card key={s.id} title={`${s.taxYear} tax return summary${s.filingType === "AMENDED" ? " (amended)" : ""}`} actions={st && <Badge tone={st.tone}>{st.label}</Badge>}>
            <p className="mb-3 text-sm text-slate-700">Please review these key figures from your prepared return. If everything looks right, approve it for filing. If something is wrong or missing, request changes and tell us what to fix.</p>
            <SummaryFigures s={s} />
            {s.status !== "SENT" && s.items && <div className="mt-4"><SummaryItems items={s.items} /></div>}
            {s.status === "SENT" && s.items && (
              <ActionForm action={(readOnly ? previewFormAction : requestSummaryChangesAction.bind(null, clientId, s.id))} className="mt-4 space-y-3" >
                <p className="text-sm font-semibold text-navy-900">Check every item below. If one is wrong, tick “This is wrong” and tell us what it should be.</p>
                <SummaryItems items={s.items} flagName={!readOnly} />
                <div className="rounded-xl border-2 border-amber-200 bg-amber-50/50 p-4">
                  <p className="font-semibold text-navy-900">Missing something, or anything else to change?</p>
                  <label className="mt-2 block text-sm">For example, a W-2, 1099 or other form that isn&apos;t listed above
                    <textarea className="input mt-1 min-h-20" name="note" maxLength={2000} disabled={readOnly} />
                  </label>
                  <p className="mt-1 text-xs text-slate-600">Requesting changes places your return on hold until we send you an updated summary.</p>
                  <Button type="submit" variant="secondary" className="mt-2" disabled={readOnly}>REQUEST CHANGES</Button>
                  {readOnly && <PreviewOffNote className="mt-1" />}
                </div>
              </ActionForm>
            )}
            <p className="mt-3 text-xs text-slate-600">{NOT_8879}</p>
            {s.status === "CHANGES_REQUESTED" && (
              <Notice tone="warn" title="Your return is on hold">
                You asked for changes on {fmtDateTime(s.changesRequestedAt)}: “{s.changesRequestNote}”. Our office will review it and send you an updated summary to approve.
              </Notice>
            )}
            {s.status === "CLIENT_APPROVED" && (
              <Notice tone="success" title="Approved for filing">
                {roles.map((r) => signed.get(r)).filter(Boolean).map((g) => `${g!.signerName} signed ${fmtDateTime(g!.signedAt)}`).join(" · ")}. Our office will file your return and let you know when it&apos;s accepted.
              </Notice>
            )}
            {s.status === "SENT" && (
              <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-2">
                {roles.map((role) => {
                  const g = signed.get(role);
                  const name = role === "SPOUSE" ? s.spouseName! : s.taxpayerName;
                  if (g) return <Notice key={role} tone="success" title={role === "SPOUSE" ? "Spouse approved" : "Taxpayer approved"}>{g.signerName} signed {fmtDateTime(g.signedAt)}.{roles.length > 1 && signed.size < roles.length ? " The other spouse's approval is still needed." : ""}</Notice>;
                  return (
                    <ActionForm key={role} action={(readOnly ? previewFormAction : approveSummaryAction.bind(null, clientId, s.id, role))} className="min-w-0 rounded-xl border-2 border-emerald-200 bg-emerald-50/50 p-4">
                      <p className="font-semibold text-navy-900">{roles.length > 1 ? (role === "SPOUSE" ? `Spouse approval — ${name}` : `Taxpayer approval — ${name}`) : "Approve for filing"}</p>
                      {roles.length > 1 && <p className="text-xs text-slate-600">On a joint return each spouse approves separately, in their own name.</p>}
                      <label className="mt-2 flex items-start gap-2 text-sm"><input type="checkbox" name="agree" required className="mt-1 accent-navy-900" disabled={readOnly} /> <span>{consentText(role, name, s.taxYear)}</span></label>
                      <label className="mt-2 block text-sm font-semibold text-navy-900">Type your full name to sign: <span className="font-normal text-slate-600">{name}</span>
                        <input className="input mt-1" name="signerName" required autoComplete="off" disabled={readOnly} aria-label={`${role === "SPOUSE" ? "Spouse" : "Taxpayer"} signature`} />
                      </label>
                      <p className="mt-1 text-xs text-slate-600">Your signature is recorded with the date, time and your device for our records.</p>
                      <Button type="submit" className="mt-2" disabled={readOnly}>APPROVE FOR FILING</Button>
                      {readOnly && <PreviewOffNote className="mt-1" />}
                    </ActionForm>
                  );
                })}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
