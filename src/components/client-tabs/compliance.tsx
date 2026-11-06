import Link from "next/link";
import type { Actor } from "@/lib/auth/actor";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Notice } from "@/components/ui";
import { fmtD, NeedsVerification, SwitchesBanner } from "@/components/compliance/bits";
import { clientComplianceSummary } from "@/lib/services/compliance/views";
import { ENTITY_KINDS } from "@/lib/services/compliance/entities";
import { PROPOSALS } from "@/lib/services/compliance/proposal";
import { complianceSettings } from "@/lib/services/compliance/settings";
import { createEntityAction, applyProposalAction } from "@/app/actions/compliance";

/** Client profile → Tax & Compliance: this client's entities, each with its own calendar. */
export async function ComplianceTab({ clientId, actor }: { clientId: string; actor: Actor }) {
  const { access, entities } = await clientComplianceSummary(actor, clientId);
  const settings = await complianceSettings();
  const manage = access.level === "MANAGE";
  return (
    <div className="space-y-5" data-testid="client-compliance-tab">
      <SwitchesBanner clientNotificationsAuthorized={settings.clientNotificationsAuthorized} staffEmailReminders={settings.staffEmailReminders} isOwner={access.isOwner} />
      <Card title="Entities" actions={<span className="flex gap-3 text-sm"><Link href={`/compliance?clientId=${clientId}`} className="underline">Tax Due Board</Link><Link href={`/compliance/missing-info?clientId=${clientId}`} className="underline">Missing information</Link></span>}>
        {entities.length === 0 ? <EmptyState title="No compliance entities yet">Add the business (and any nonprofit or second entity) below.</EmptyState> : (
          <ul className="divide-y divide-ivory-200">
            {entities.map((e) => {
              const next = e.periods.filter((p) => p.obligation.status === "ACTIVE")[0];
              return (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <Link href={`/compliance/entities/${e.id}`} className="font-semibold underline decoration-gold-500">{e.legalName || e.dba || `(${ENTITY_KINDS[e.kind as keyof typeof ENTITY_KINDS] ?? e.kind} — legal name missing)`}</Link>
                    <p className="text-xs text-slate-600">{ENTITY_KINDS[e.kind as keyof typeof ENTITY_KINDS] ?? e.kind} · {e.obligations.length} obligation(s) · {e.obligations.filter((o) => o.status === "PROPOSED").length} proposed · {e.obligations.filter((o) => o.verification !== "VERIFIED").length} need verification</p>
                    {next && <p className="text-xs">Next: {next.obligation.formName} {next.periodKey} due {fmtD(next.extendedDue ?? next.adjustedDue)} {next.dueCertainty !== "CONFIRMED" && <NeedsVerification />}</p>}
                  </div>
                  <span className="flex gap-2"><Badge tone={e.status === "ACTIVE" ? "green" : e.status === "PROPOSED" ? "gold" : "gray"}>{e.status}</Badge>{e.portalVisible && <Badge tone="navy">Client-visible</Badge>}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {manage && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="Add an entity">
            <ActionForm action={createEntityAction.bind(null, clientId)} className="grid gap-2">
              <select name="kind" className="input" aria-label="Entity type">{Object.entries(ENTITY_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <label className="flex items-center gap-2 text-sm"><input type="radio" name="mode" value="prepopulate" defaultChecked /> Prefill from this client&apos;s records (each fact shows its source)</label>
              <label className="flex items-center gap-2 text-sm"><input type="radio" name="mode" value="blank" /> Start blank</label>
              <input name="legalName" placeholder="Legal name (blank start only)" className="input" />
              <Button>Add entity</Button>
            </ActionForm>
          </Card>
          <Card title="Apply proposed compliance profile">
            <Notice>Creates a business entity (and the owner&apos;s nonprofit, if the package has one) with every item <strong>Proposed / Needs verification</strong>. Nothing is confirmed, no reminder starts and no identifier is filled in until Tabitha reviews and approves each item.</Notice>
            <ActionForm action={applyProposalAction.bind(null, clientId)} className="mt-3 grid gap-2" confirm="Apply this proposed profile to this client? Items stay Proposed until approved.">
              <select name="package" className="input" aria-label="Proposal">{Object.values(PROPOSALS).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</select>
              <Button variant="secondary" data-testid="apply-proposal">Apply proposed compliance profile</Button>
            </ActionForm>
          </Card>
        </div>
      )}
    </div>
  );
}
