import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field } from "@/components/ui";
import { createNonprofitAction, filingServiceAction, hasNonprofitAction, linkNonprofitAction } from "@/app/actions/nonprofits";
import { HAS_NONPROFIT, linkableNonprofits, nonprofitsForClient } from "@/lib/services/nonprofit-links";
import { FILING_SERVICE } from "@/lib/services/nonprofits";

/**
 * Nonprofits on every client record — bookkeeping enrollment isn't needed.
 * "Has a nonprofit?" is kept on the owner's main record; each nonprofit is its
 * own organization record; only "TTurner handles its filings: Yes" puts it on
 * Nonprofit Filings.
 */
export async function NonprofitCard({ clientId }: { clientId: string }) {
  const { anchor, has, orgs, flags, ownerIsNonprofit } = await nonprofitsForClient(clientId);
  const linkable = ownerIsNonprofit ? [] : await linkableNonprofits(clientId);
  return (
    <Card title="Nonprofit" actions={<span className="text-sm text-slate-600">For any client — bookkeeping not required</span>}>
      <div className="space-y-3 text-sm" data-testid="nonprofit-card">
        {!ownerIsNonprofit && (
          <ActionForm action={hasNonprofitAction.bind(null, clientId)} className="flex flex-wrap items-end gap-2" showSuccess={false}>
            <Field label={`Does ${anchor.displayName} have a nonprofit?`}>
              <select className="input" name="hasNonprofit" defaultValue={has ?? ""} data-testid="has-nonprofit">
                <option value="" disabled>Not recorded</option>
                {Object.entries(HAS_NONPROFIT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Button type="submit" variant="secondary">Save</Button>
          </ActionForm>
        )}

        {flags.length > 0 && <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900" data-testid="nonprofit-flags">Needs review: {flags.join(" · ")}</p>}

        {orgs.length > 0 && (
          <ul className="divide-y divide-ivory-200" data-testid="nonprofit-orgs">
            {orgs.map((o) => {
              const service = o.nonprofitProfile?.filingService as keyof typeof FILING_SERVICE | null | undefined;
              return (
                <li key={o.id} className="space-y-2 py-2" data-org={o.businessName || o.displayName}>
                  <div className="flex flex-wrap items-center gap-2">
                    {o.id === clientId ? <strong>{o.businessName || o.displayName}</strong> : <Link className="font-semibold underline" href={`/clients/${o.id}`}>{o.businessName || o.displayName}</Link>}
                    <Badge tone="gray">Nonprofit organization</Badge>
                    {o.status === "PROSPECT" && <Badge tone="amber">Prospect</Badge>}
                  </div>
                  <ActionForm action={filingServiceAction.bind(null, clientId, o.id)} className="flex flex-wrap items-end gap-2" showSuccess={false}>
                    <Field label="Does TTurner handle its annual filings?">
                      <select className="input" name="filingService" defaultValue={service ?? ""} data-testid="filing-service">
                        <option value="" disabled>Not recorded</option>
                        {Object.entries(FILING_SERVICE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </Field>
                    <Button type="submit" variant="secondary">Save</Button>
                    {service === "YES" ? (
                      <Link className="text-sm font-semibold underline" href={`/nonprofits#np-${o.id}`} data-testid="open-tracker">Open filing tracker</Link>
                    ) : (
                      <span className="text-xs text-slate-600">On Nonprofit Filings only when this is Yes.</span>
                    )}
                  </ActionForm>
                </li>
              );
            })}
          </ul>
        )}

        {!ownerIsNonprofit && (
          <details data-testid="add-nonprofit">
            <summary className="cursor-pointer font-semibold underline">Add / Link Nonprofit</summary>
            <p className="mt-2 text-xs text-slate-600">
              The nonprofit gets its own organization record, linked to {anchor.displayName}. This record isn&apos;t changed or retyped, and linking doesn&apos;t give anyone portal access — grant it per organization under <em>Add / Link Another Business</em>. Formation inquiries belong in the <strong>Nonprofit Interest</strong> group instead; that group never adds anyone to Nonprofit Filings.
            </p>
            <ActionForm action={createNonprofitAction.bind(null, clientId)} className="mt-2 grid gap-2 sm:grid-cols-3" resetOnSuccess>
              <Field label="Nonprofit's legal name"><input className="input" name="name" required /></Field>
              <Field label="Email (optional)"><input className="input" type="email" name="email" /></Field>
              <div className="flex items-end"><Button type="submit">Create &amp; link nonprofit</Button></div>
            </ActionForm>
            {linkable.length > 0 && (
              <ActionForm action={linkNonprofitAction.bind(null, clientId)} className="mt-2 flex flex-wrap items-end gap-2">
                <Field label="…or link an existing nonprofit record">
                  <select className="input" name="orgId" defaultValue="">
                    <option value="" disabled>Choose</option>
                    {linkable.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
                  </select>
                </Field>
                <Button type="submit" variant="secondary">Link nonprofit</Button>
              </ActionForm>
            )}
          </details>
        )}
      </div>
    </Card>
  );
}
