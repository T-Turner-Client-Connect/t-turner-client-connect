import type { TaxReturnSummary } from "@prisma/client";
import type { Actor } from "@/lib/auth/actor";
import { prisma } from "@/lib/prisma";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice } from "@/components/ui";
import { SummaryFigures } from "@/components/tax-summary-view";
import { createSummaryAction, reviseSummaryAction, summaryStepAction, updateSummaryAction } from "@/app/actions/tax-summary";
import { FILING_STATUSES, NOT_8879, requiredRoles, SUMMARY_STATUS, type Dependent, type StateResult } from "@/lib/services/tax-summary";
import { fmtDateTime } from "@/lib/format";
import { sendBlockers } from "@/lib/services/tax-summary-items";
import { SummaryItemsPanel } from "./tax-summary-items";

const dollars = (c: number | undefined) => (c ? (Math.abs(c) / 100).toFixed(2) : "");
const kind = (c: number | undefined) => (!c ? "EVEN" : c > 0 ? "REFUND" : "OWED");

function ResultInputs({ prefix, cents, label }: { prefix: string; cents?: number; label: string }) {
  return (
    <div className="flex gap-2">
      <select className="input w-auto" name={`${prefix}Kind`} defaultValue={kind(cents)} aria-label={`${label}: refund or owed`}>
        <option value="REFUND">Refund</option><option value="OWED">Owed</option><option value="EVEN">Even (0)</option>
      </select>
      <input className="input" name={`${prefix}Amount`} inputMode="decimal" defaultValue={dollars(cents)} placeholder="0.00" aria-label={`${label} amount`} />
    </div>
  );
}

/** The figures form, entered from the return prepared in TaxAct. */
function SummaryFields({ s, defaults, create }: { s?: TaxReturnSummary; defaults: { taxpayerName: string; spouseName: string }; create?: boolean }) {
  const deps = ((s?.dependents as Dependent[]) ?? []).concat(Array(4).fill({ name: "", relationship: "" })).slice(0, Math.max(4, ((s?.dependents as Dependent[]) ?? []).length + 1));
  const states = ((s?.stateResults as StateResult[]) ?? []).concat([{ state: "", resultCents: 0 }, { state: "", resultCents: 0 }]).slice(0, Math.max(2, ((s?.stateResults as StateResult[]) ?? []).length + 1));
  const thisYear = new Date().getFullYear();
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {create && (
        <>
          <Field label="Tax year">
            <select className="input" name="taxYear" defaultValue={thisYear - 1} required>{Array.from({ length: 6 }, (_, i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}</select>
          </Field>
          <Field label="Original or amended">
            <select className="input" name="filingType" defaultValue="ORIGINAL"><option value="ORIGINAL">Original</option><option value="AMENDED">Amended</option></select>
          </Field>
        </>
      )}
      <Field label="Filing status">
        <select className="input" name="filingStatus" defaultValue={s?.filingStatus ?? ""} required>
          <option value="">Choose…</option>
          {Object.entries(FILING_STATUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <Field label="Taxpayer name (as on the return)"><input className="input" name="taxpayerName" defaultValue={s?.taxpayerName ?? defaults.taxpayerName} required /></Field>
      <Field label="Spouse name" hint="Joint or separate returns only; ignored otherwise. A joint return needs the spouse's own approval.">
        <input className="input" name="spouseName" defaultValue={s?.spouseName ?? defaults.spouseName} />
      </Field>
      <fieldset className="sm:col-span-2 lg:col-span-4">
        <legend className="mb-1 text-sm font-semibold text-navy-900">Dependents claimed (names only — no SSNs)</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {deps.map((d, i) => (
            <div key={i} className="flex gap-2">
              <input className="input" name={`depName_${i}`} defaultValue={d.name} placeholder="Name" aria-label={`Dependent ${i + 1} name`} />
              <input className="input w-40" name={`depRel_${i}`} defaultValue={d.relationship} placeholder="Relationship" aria-label={`Dependent ${i + 1} relationship`} />
            </div>
          ))}
        </div>
      </fieldset>
      <Field label="Wages"><input className="input" name="wages" inputMode="decimal" defaultValue={dollars(s?.wagesCents)} placeholder="0.00" /></Field>
      <Field label="Other income"><input className="input" name="otherIncome" inputMode="decimal" defaultValue={s?.otherIncomeCents ? (s.otherIncomeCents / 100).toFixed(2) : ""} placeholder="0.00" /></Field>
      <Field label="Total income"><input className="input" name="totalIncome" inputMode="decimal" defaultValue={dollars(s?.totalIncomeCents)} placeholder="Read from the return" /></Field>
      <Field label="Adjusted gross income"><input className="input" name="agi" inputMode="decimal" defaultValue={s?.agiCents ? (s.agiCents / 100).toFixed(2) : ""} placeholder="Read from the return" /></Field>
      <Field label="Deduction">
        <select className="input" name="deductionType" defaultValue={s?.deductionType ?? "STANDARD"}><option value="STANDARD">Standard</option><option value="ITEMIZED">Itemized</option></select>
      </Field>
      <Field label="Deduction amount"><input className="input" name="deduction" inputMode="decimal" defaultValue={dollars(s?.deductionCents)} placeholder="0.00" /></Field>
      <Field label="Taxable income"><input className="input" name="taxableIncome" inputMode="decimal" defaultValue={dollars(s?.taxableIncomeCents)} placeholder="0.00" /></Field>
      <Field label="Federal refund or owed"><ResultInputs prefix="federal" cents={s?.federalResultCents} label="Federal" /></Field>
      {states.map((st, i) => (
        <Field key={i} label={`State ${i + 1} (two letters) and result`} className="lg:col-span-2">
          <div className="flex gap-2">
            <input className="input w-20" name={`state_${i}`} defaultValue={st.state} maxLength={2} placeholder="AL" aria-label={`State ${i + 1}`} />
            <select className="input w-auto" name={`stateKind_${i}`} defaultValue={kind(st.resultCents)} aria-label={`State ${i + 1} refund or owed`}>
              <option value="REFUND">Refund</option><option value="OWED">Owed</option><option value="EVEN">Even (0)</option>
            </select>
            <input className="input" name={`stateAmount_${i}`} inputMode="decimal" defaultValue={dollars(st.resultCents)} placeholder="0.00" aria-label={`State ${i + 1} amount`} />
          </div>
        </Field>
      ))}
      <fieldset className="sm:col-span-2 lg:col-span-4">
        <legend className="mb-1 text-sm font-semibold text-navy-900">Direct deposit for the client to verify (only the last four digits are kept)</legend>
        <div className="grid gap-2 sm:grid-cols-4">
          <input className="input" name="depositBankName" defaultValue={s?.depositBankName ?? ""} placeholder="Bank name" aria-label="Bank name" />
          <select className="input" name="depositAccountType" defaultValue={s?.depositAccountType ?? ""} aria-label="Account type"><option value="">No direct deposit</option><option value="CHECKING">Checking</option><option value="SAVINGS">Savings</option></select>
          <input className="input" name="depositRouting" defaultValue={s?.depositRoutingLast4 ?? ""} inputMode="numeric" placeholder="Routing — last 4" aria-label="Routing number last four" autoComplete="off" />
          <input className="input" name="depositAccount" defaultValue={s?.depositAccountLast4 ?? ""} inputMode="numeric" placeholder="Account — last 4" aria-label="Account number last four" autoComplete="off" />
        </div>
      </fieldset>
      <Field label="Note to the client (optional)" className="sm:col-span-2 lg:col-span-4"><input className="input" name="officeNote" defaultValue={s?.officeNote ?? ""} maxLength={1000} /></Field>
    </div>
  );
}

/**
 * Stage 1 of 2 — Tax Return Summary & Approval (before filing). The client
 * approves key figures, not the full return.
 */
export async function TaxSummaryStaff({ clientId, user: _user }: { clientId: string; user: Actor }) {
  void _user;
  const [client, summaries] = await Promise.all([
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { firstName: true, middleName: true, lastName: true, displayName: true, spouseFirstName: true, spouseMiddleName: true, spouseLastName: true } }),
    prisma.taxReturnSummary.findMany({ where: { clientId }, include: { signatures: true, items: { orderBy: { sortOrder: "asc" } }, checks: { orderBy: { createdAt: "asc" } } }, orderBy: [{ taxYear: "desc" }, { version: "desc" }] }),
  ]);
  const staff = new Map((await prisma.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const join = (...p: (string | null)[]) => p.filter(Boolean).join(" ");
  const defaults = { taxpayerName: join(client.firstName, client.middleName, client.lastName) || client.displayName, spouseName: join(client.spouseFirstName, client.spouseMiddleName, client.spouseLastName) };
  const active = summaries.filter((s) => s.status !== "SUPERSEDED" && s.status !== "WITHDRAWN");
  const history = summaries.filter((s) => s.status === "SUPERSEDED" || s.status === "WITHDRAWN");
  const blockers = new Map(await Promise.all(active.filter((s) => s.status === "DRAFT").map(async (s) => [s.id, await sendBlockers(s.id)] as const)));

  return (
    <Card title="Step 1 · Tax Return Summary & Approval (before filing)">
      <p className="mb-2 rounded-lg bg-navy-50 px-3 py-2 text-sm font-semibold text-navy-900" data-testid="skip-step-1-hint">Already filed and accepted? Skip this step and use <a className="underline" href="#deliver-accepted">Deliver accepted return</a>.</p>
      <p className="mb-3 text-sm text-slate-600">
        Enter the key figures from the return prepared in TaxAct and send the summary to the client&apos;s portal. The client approves it for filing (electronic signature) or requests changes. Once approved, only Tabitha files it in TaxAct. {NOT_8879}
      </p>
      <div className="space-y-4" data-testid="tax-summaries">
        {active.map((s) => {
          const st = SUMMARY_STATUS[s.status];
          const sigs = s.signatures.filter((g) => !g.invalidatedAt);
          const roles = requiredRoles(s);
          const sameLogin = sigs.length > 1 && new Set(sigs.map((g) => g.portalUserId)).size === 1;
          return (
            <div key={s.id} className="rounded-xl border border-ivory-200 p-3" data-testid={`summary-${s.taxYear}`}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-navy-900">{s.taxYear} {s.filingType === "AMENDED" ? "amended " : ""}summary · version {s.version}</p>
                <Badge tone={st.tone as never}>{st.label}</Badge>
              </div>
              {s.status === "CHANGES_REQUESTED" && (
                <Notice tone="warn" title="On hold — the client asked for changes">
                  {s.changesRequestNote} <span className="text-xs">({fmtDateTime(s.changesRequestedAt)})</span> Review the correction, then use “Revise figures” to send an updated summary.
                </Notice>
              )}
              {s.status === "DRAFT" ? (
                <details>
                  <summary className="cursor-pointer text-sm font-semibold underline">Return totals, people and direct deposit</summary>
                  <ActionForm action={updateSummaryAction.bind(null, s.id)} className="mt-2 space-y-3">
                    <SummaryFields s={s} defaults={defaults} />
                    <Button type="submit" variant="secondary">Save draft</Button>
                  </ActionForm>
                </details>
              ) : (
                <SummaryFigures s={s} />
              )}
              <SummaryItemsPanel s={s} items={s.items} checks={s.checks} staff={staff} blockers={blockers.get(s.id) ?? []} />
              <ul className="mt-2 text-xs text-slate-600">
                <li>Prepared by {staff.get(s.preparedById) ?? "staff"}{s.sentAt && ` · sent ${fmtDateTime(s.sentAt)} by ${staff.get(s.sentById ?? "") ?? "staff"}`}</li>
                {roles.map((r) => {
                  const g = sigs.find((x) => x.role === r);
                  return (
                    <li key={r}>
                      {r === "SPOUSE" ? "Spouse" : "Taxpayer"} approval: {g ? <>signed “{g.signerName}” {fmtDateTime(g.signedAt)}{g.ipAddress ? ` · IP ${g.ipAddress}` : ""}</> : s.status === "DRAFT" ? "not sent yet" : "waiting"}
                    </li>
                  );
                })}
                {sameLogin && <li className="font-semibold text-amber-800">Both signatures came from the same portal login. Confirm with the spouse if needed.</li>}
              </ul>
              <div className="mt-2 flex flex-wrap gap-2">
                {s.status === "DRAFT" && (
                  <ActionForm action={summaryStepAction.bind(null, s.id, "send")} confirm="Send this summary to the client's portal for approval? Only verified items are included, and the figures are locked once sent.">
                    <Button type="submit" variant="gold" disabled={(blockers.get(s.id) ?? []).length > 0}>Send to client for approval</Button>
                  </ActionForm>
                )}
                {(s.status === "SENT" || s.status === "CHANGES_REQUESTED" || s.status === "CLIENT_APPROVED") && (
                  <details className="text-sm">
                    <summary className="cursor-pointer font-semibold underline">Revise figures (new version)</summary>
                    <ActionForm action={reviseSummaryAction.bind(null, s.id)} className="mt-2 flex flex-wrap items-end gap-2" confirm={s.status === "CLIENT_APPROVED" ? "This cancels the client's approval. They must approve the new version before filing. Continue?" : undefined}>
                      <Field label="What is changing?"><input className="input" name="reason" required minLength={3} /></Field>
                      <Button type="submit" variant="secondary">Create new version</Button>
                    </ActionForm>
                    {s.status === "CLIENT_APPROVED" && <p className="mt-1 text-xs text-amber-800">Changing figures after approval invalidates the approval; the client must approve again.</p>}
                  </details>
                )}
                {(s.status === "DRAFT" || s.status === "SENT" || s.status === "CHANGES_REQUESTED") && (
                  <ActionForm action={summaryStepAction.bind(null, s.id, "withdraw")} confirm="Withdraw this summary? The client will no longer see it.">
                    <Button type="submit" variant="ghost">Withdraw</Button>
                  </ActionForm>
                )}
              </div>
            </div>
          );
        })}
        {active.length === 0 && <p className="text-sm text-slate-600">No summary yet.</p>}
      </div>
      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-semibold underline">Start a new tax return summary</summary>
        <ActionForm action={createSummaryAction.bind(null, clientId)} className="mt-2 space-y-3" resetOnSuccess>
          <SummaryFields defaults={defaults} create />
          <Button type="submit">Save summary draft</Button>
        </ActionForm>
      </details>
      {history.length > 0 && (
        <details className="mt-3 text-xs text-slate-600">
          <summary className="cursor-pointer">Earlier versions ({history.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {history.map((s) => <li key={s.id}>{s.taxYear} v{s.version} · {SUMMARY_STATUS[s.status].label}{s.invalidatedReason ? ` · “${s.invalidatedReason}”` : ""} · {fmtDateTime(s.invalidatedAt)}</li>)}
          </ul>
        </details>
      )}
    </Card>
  );
}
