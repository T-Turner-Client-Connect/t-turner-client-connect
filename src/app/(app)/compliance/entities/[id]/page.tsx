import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { ComplianceNav, fmtD, LABEL, NeedsVerification, StatusBadge, SwitchesBanner } from "@/components/compliance/bits";
import { requireCompliancePage } from "@/lib/compliance/page-gate";
import { entityWorkspace, clientStatus } from "@/lib/services/compliance/views";
import { OBLIGATION_STATUS, previewDates } from "@/lib/services/compliance/obligations";
import { ACCESS_METHODS, ACCOUNT_TYPES, ENTITY_KINDS, EXEMPTION_STATUSES, TAX_CLASSIFICATIONS } from "@/lib/services/compliance/entities";
import { DOC_KINDS } from "@/lib/services/compliance/periods";
import { complianceSettings } from "@/lib/services/compliance/settings";
import { CATEGORY_LABELS } from "@/lib/compliance/rules-data";
import { WEEKEND_RULES } from "@/lib/compliance/dates";
import { prisma } from "@/lib/prisma";
import * as A from "@/app/actions/compliance";

export const metadata = { title: "Compliance entity" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SERVICES = ["TAX_BUSINESS", "TAX_INDIVIDUAL", "K1_PREPARATION", "TAX_NONPROFIT", "BOOKKEEPING", "PAYROLL", "NONPROFIT_SERVICES", "BUSINESS_FORMATION"];

export default async function EntityPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor, access } = await requireCompliancePage();
  const { id } = await params;
  const w = await entityWorkspace(actor, id);
  if (!w) notFound();
  const { e } = w;
  const manage = access.level === "MANAGE";
  const owner = access.isOwner;
  const settings = await complianceSettings();
  const sources = (e.factSources ?? {}) as Record<string, string>;
  const src = (k: string) => (sources[k] ? <span className="ml-1 text-[11px] font-normal text-slate-500">({sources[k]})</span> : null);
  const name = e.legalName || e.dba || `(${ENTITY_KINDS[e.kind as keyof typeof ENTITY_KINDS] ?? e.kind} — legal name missing)`;
  const previews = new Map<string, string | null>();
  for (const o of e.obligations.filter((x) => x.status === "PROPOSED")) previews.set(o.id, (await previewDates(o.id))[0]?.adjusted ?? null);
  const templates = await prisma.complianceIndustryTemplate.findMany({ where: { archivedAt: null }, orderBy: { name: "asc" } });
  const docsById = new Map(e.documents.map((d) => [d.documentId, d]));

  return (
    <>
      <PageHeader
        title={name}
        subtitle={<span className="flex flex-wrap items-center gap-2"><Link href={`/clients/${e.client.id}?tab=compliance`} className="underline">{e.client.displayName}</Link><Badge>{ENTITY_KINDS[e.kind as keyof typeof ENTITY_KINDS] ?? e.kind}</Badge><Badge tone={e.status === "ACTIVE" ? "green" : e.status === "PROPOSED" ? "gold" : "gray"}>{e.status === "PROPOSED" ? "Proposed — owner review" : e.status}</Badge>{e.linkedEntity && <span>Linked to <Link className="underline" href={`/compliance/entities/${e.linkedEntity.id}`}>{e.linkedEntity.legalName || e.linkedEntity.dba || "business entity"}</Link></span>}{e.linkedFrom.map((l) => <span key={l.id}>Owner&apos;s {l.kind === "NONPROFIT" ? "nonprofit" : "entity"}: <Link className="underline" href={`/compliance/entities/${l.id}`}>{l.legalName || l.dba || "(legal name missing)"}</Link></span>)}</span>}
        actions={owner && e.status === "PROPOSED" ? <ActionForm action={A.entityStatusAction.bind(null, e.id, "ACTIVE")}><Button>Approve entity</Button></ActionForm> : undefined}
      />
      <SwitchesBanner clientNotificationsAuthorized={settings.clientNotificationsAuthorized} staffEmailReminders={settings.staffEmailReminders} isOwner={owner} />
      <ComplianceNav current="" isOwner={owner} />
      <nav aria-label="Entity sections" className="mb-4 flex flex-wrap gap-3 text-sm font-semibold">
        {["profile", "portals", "obligations", "calendar", "documents", "approvals", "history"].map((s) => <a key={s} href={`#${s}`} className="underline decoration-gold-500 underline-offset-4">{s === "portals" ? "Accounts & Portals" : s[0].toUpperCase() + s.slice(1)}</a>)}
      </nav>
      {e.kind === "NONPROFIT" && <div className="mb-4"><Notice>This nonprofit is its own entity: its calendar, approvals and documents never mix with the business&apos;s.{w.nonprofitProfile ? ` Nonprofit Filings tracker form: ${w.nonprofitProfile.formType ?? "not determined yet"}.` : " Not linked to a Nonprofit Filings record yet (990 form pending gross receipts)."}</Notice></div>}

      <div className="space-y-5">
        <Card title="Entity profile" className="scroll-mt-4" actions={<span className="text-xs text-slate-600">Sources shown in brackets. Nothing is guessed.</span>}>
          <section id="profile" data-testid="entity-profile">
            <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
              <span><strong>EIN:</strong> {e.einMasked ?? <span className="text-amber-800">Not recorded</span>}{src("ein")}</span>
              {w.access.canRevealEin && e.einMasked && (
                <ActionForm action={A.revealEinAction.bind(null, e.id)} className="flex flex-wrap items-center gap-2"><input name="reason" required placeholder="Reason (logged)" className="input w-56" /><Button variant="secondary">Reveal</Button></ActionForm>
              )}
              {manage && <ActionForm action={A.setEinAction.bind(null, e.id)} className="flex items-center gap-2" resetOnSuccess><input name="ein" placeholder="Set EIN (12-3456789)" className="input w-48" autoComplete="off" /><Button variant="secondary">Save EIN</Button></ActionForm>}
            </div>
            <ActionForm action={A.updateEntityAction.bind(null, e.id)} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <fieldset disabled={!manage} className="contents">
                <Field label="Entity type"><select name="kind" defaultValue={e.kind} className="input">{Object.entries(ENTITY_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label="Legal name" hint={sources.legalName}><input name="legalName" defaultValue={e.legalName ?? ""} className="input" /></Field>
                <Field label="DBA"><input name="dba" defaultValue={e.dba ?? ""} className="input" /></Field>
                <Field label="Legal entity type (detail)" hint="e.g. Single-member LLC, Alabama corporation"><input name="legalEntityType" defaultValue={e.legalEntityType ?? ""} className="input" /></Field>
                <Field label="Federal tax classification" hint={sources.taxClassification}><select name="taxClassification" defaultValue={e.taxClassification ?? ""} className="input"><option value="">Not recorded</option>{Object.entries(TAX_CLASSIFICATIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label="S election effective date"><input type="date" name="sCorpEffectiveDate" defaultValue={e.sCorpEffectiveDate ? e.sCorpEffectiveDate.toISOString().slice(0, 10) : ""} className="input" /></Field>
                <Field label="Fiscal year-end" hint={sources.fiscalYearEndMonth}><select name="fiscalYearEndMonth" defaultValue={e.fiscalYearEndMonth ?? ""} className="input"><option value="">Not recorded</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></Field>
                <Field label="State of formation"><input name="stateOfFormation" defaultValue={e.stateOfFormation ?? ""} maxLength={2} className="input" /></Field>
                <Field label="States of operation" hint={sources.statesOfOperation}><input name="statesOfOperation" defaultValue={e.statesOfOperation.join(", ")} className="input" /></Field>
                <Field label="Industry"><input name="industry" defaultValue={e.industry ?? ""} className="input" /></Field>
                <Field label="NAICS code"><input name="naicsCode" defaultValue={e.naicsCode ?? ""} className="input" /></Field>
                <Field label="Activity tags" hint="e.g. restaurant, alcohol (or no-alcohol), retail"><input name="activityTags" defaultValue={e.activityTags.join(", ")} className="input" /></Field>
                <Field label="Activity description" className="sm:col-span-2 lg:col-span-3"><input name="activityDescription" defaultValue={e.activityDescription ?? ""} className="input" /></Field>
                <Field label="Payroll" hint={sources.payrollStatus}><select name="payrollStatus" defaultValue={e.payrollStatus} className="input"><option value="UNKNOWN">Unknown</option><option value="YES">Yes</option><option value="NO">No</option></select></Field>
                <Field label="Employees"><input name="employeeCount" type="number" min={0} defaultValue={e.employeeCount ?? ""} className="input" /></Field>
                <Field label="Payroll provider"><input name="payrollProvider" defaultValue={e.payrollProvider ?? ""} className="input" /></Field>
                <Field label="Issues Forms 1099"><select name="issues1099" defaultValue={e.issues1099} className="input"><option value="UNKNOWN">Unknown</option><option value="YES">Yes</option><option value="NO">No</option></select></Field>
                {e.kind === "NONPROFIT" ? (
                  <Field label="IRS exemption status"><select name="irsExemptionStatus" defaultValue={e.irsExemptionStatus ?? ""} className="input"><option value="">Not recorded</option>{Object.entries(EXEMPTION_STATUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                ) : (
                  <Field label="Owner owns/operates a nonprofit"><select name="ownerHasNonprofit" defaultValue={e.ownerHasNonprofit} className="input"><option value="UNKNOWN">Unknown</option><option value="YES">Yes</option><option value="NO">No</option></select></Field>
                )}
                <fieldset className="sm:col-span-2 lg:col-span-3"><legend className="mb-1 text-sm font-semibold">Services the firm is contracted for {src("services")}</legend><div className="flex flex-wrap gap-3 text-sm">{SERVICES.map((s) => <label key={s} className="flex items-center gap-1.5"><input type="checkbox" name="services" value={s} defaultChecked={e.services.includes(s)} />{s.replace(/_/g, " ").toLowerCase()}</label>)}</div></fieldset>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="portalVisible" defaultChecked={e.portalVisible} /> Show in the client portal</label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="clientNotificationsEnabled" defaultChecked={e.clientNotificationsEnabled} /> Client notifications for this entity (also needs the owner&apos;s switch)</label>
                <Field label="Notes" className="sm:col-span-2 lg:col-span-3"><textarea name="notes" defaultValue={e.notes ?? ""} rows={2} className="input" /></Field>
                {manage && <div><Button>Save profile</Button></div>}
              </fieldset>
            </ActionForm>
          </section>
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="Business locations">
            <ul className="mb-3 divide-y divide-ivory-200 text-sm">{e.locations.map((l) => <li key={l.id} className="flex items-center justify-between gap-2 py-1.5"><span>{[l.label, l.address1, l.city, l.county ? `${l.county} County` : <span key="c" className="text-amber-800">county missing</span>, l.state].filter(Boolean).map((x, i) => <span key={i}>{i ? ", " : ""}{x}</span>)}{l.source && <span className="ml-1 text-[11px] text-slate-500">({l.source})</span>}</span>{manage && <ActionForm action={A.removeLocationAction.bind(null, e.id, l.id)}><button className="text-xs text-red-700 underline">Remove</button></ActionForm>}</li>)}{!e.locations.length && <li className="py-1.5 text-amber-800">No locations recorded.</li>}</ul>
            {manage && <ActionForm action={A.addLocationAction.bind(null, e.id)} resetOnSuccess className="grid grid-cols-2 gap-2"><input name="label" placeholder="Label" className="input" /><input name="address1" placeholder="Address" className="input" /><input name="city" placeholder="City" className="input" /><input name="county" placeholder="County" className="input" /><input name="state" placeholder="State" maxLength={2} className="input" /><input name="postalCode" placeholder="ZIP" className="input" /><Button variant="secondary">Add location</Button></ActionForm>}
          </Card>
          <Card title="Registered tax accounts">
            <ul className="mb-3 divide-y divide-ivory-200 text-sm" data-testid="tax-accounts">{e.taxAccounts.map((a) => <li key={a.id} className="py-1.5"><strong>{ACCOUNT_TYPES[a.type as keyof typeof ACCOUNT_TYPES] ?? a.type}</strong> · {a.jurisdictionName ?? a.agency} · {a.accountLast4 ? `…${a.accountLast4}` : <span className="text-amber-800">number missing</span>} · {a.filingFrequency ? LABEL[a.filingFrequency] : <span className="text-amber-800">frequency not recorded</span>} · <Badge tone={a.status === "ACTIVE" ? "green" : a.status === "CLOSED" ? "gray" : "amber"}>{a.status}</Badge>{a.effectiveDate && <span className="text-xs"> since {fmtD(a.effectiveDate)}</span>}</li>)}{!e.taxAccounts.length && <li className="py-1.5 text-slate-600">None recorded.</li>}</ul>
            {manage && <ActionForm action={A.saveTaxAccountAction.bind(null, e.id, null)} resetOnSuccess className="grid grid-cols-2 gap-2"><select name="type" className="input" aria-label="Type">{Object.entries(ACCOUNT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><input name="agency" required placeholder="Agency (ALDOR, Jefferson County…)" className="input" /><input name="jurisdictionName" placeholder="Jurisdiction (Alabama, Birmingham…)" className="input" /><input name="accountNumber" placeholder="Account number (encrypted)" className="input" autoComplete="off" /><select name="filingFrequency" className="input" aria-label="Frequency"><option value="">Frequency not recorded</option>{["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"].map((f) => <option key={f} value={f}>{LABEL[f]}</option>)}</select><input type="date" name="effectiveDate" className="input" aria-label="Effective date" /><select name="status" className="input" aria-label="Status">{["UNKNOWN", "ACTIVE", "PENDING", "SUSPENDED", "CLOSED"].map((s) => <option key={s}>{s}</option>)}</select><Button variant="secondary">Add account</Button></ActionForm>}
          </Card>
          <Card title="Licenses & permits">
            <ul className="mb-3 text-sm">{e.licenses.map((l) => <li key={l.id}>{l.businessLicense.name} · {l.businessLicense.jurisdiction ?? "—"} · {l.businessLicense.licenseNumber ? `#${l.businessLicense.licenseNumber}` : <span className="text-amber-800">number missing</span>} · renews {fmtD(l.businessLicense.renewalDate)}</li>)}{!e.licenses.length && <li className="text-slate-600">No Business Licenses linked.</li>}</ul>
            {manage && w.licenses.length > 0 && <ActionForm action={A.linkLicenseAction.bind(null, e.id)} className="flex gap-2"><select name="businessLicenseId" className="input">{w.licenses.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select><Button variant="secondary">Link</Button></ActionForm>}
          </Card>
          <Card title="Responsible owners & portal access">
            {manage ? <ActionForm action={A.setOwnersAction.bind(null, e.id)} className="mb-3 space-y-1 text-sm">{w.owners.map((o) => <label key={o.id} className="flex items-center gap-2"><input type="checkbox" name="owner" value={o.id} defaultChecked={e.owners.some((x) => x.businessOwnerId === o.id)} />{o.contact.name}</label>)}{!w.owners.length && <p className="text-slate-600">No business owners on this client.</p>}{w.owners.length > 0 && <Button variant="secondary">Save owners</Button>}</ActionForm> : <p className="text-sm">{e.owners.map((o) => o.businessOwner.contact.name).join(", ") || "—"}</p>}
            <p className="text-xs text-slate-600">Business-owner logins see only the entities they are responsible for, or granted below.</p>
            <ul className="mt-2 text-sm">{w.portalLogins.map((p) => { const granted = e.viewers.some((v) => v.portalUserId === p.portalUserId); return <li key={p.id} className="flex items-center justify-between py-0.5"><span>{p.portalUser.name}</span>{manage && <ActionForm action={A.viewerAction.bind(null, e.id, p.portalUserId, !granted)}><button className="text-xs underline">{granted ? "Remove grant" : "Grant view"}</button></ActionForm>}</li>; })}</ul>
          </Card>
        </div>

        <Card title="Accounts & Portals" actions={<span className="text-xs text-slate-600">No passwords or MFA codes are stored. No automated logins.</span>}>
          <section id="portals" data-testid="accounts-portals">
            <ul className="mb-3 divide-y divide-ivory-200 text-sm">{e.filingAccounts.map((a) => <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><span><strong>{a.name}</strong> · {a.accessMethod ?? "access method not recorded"}{a.accessReference && <> · ref: <code>{a.accessReference}</code></>}{a.firmAccount && <> · via firm account <em>{a.firmAccount.name}</em></>}{a.authorizations.length > 0 && <> · {a.authorizations.map((z) => `${z.formType}${z.expiresAt ? ` (exp. ${fmtD(z.expiresAt)})` : ""}`).join(", ")}</>}</span><a href={a.portalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold underline">Open portal <ExternalLink className="size-3.5" aria-hidden /></a></li>)}{!e.filingAccounts.length && <li className="py-2 text-slate-600">No portals recorded.</li>}</ul>
            {manage && <ActionForm action={A.saveFilingAccountAction.bind(null, e.id)} resetOnSuccess className="grid gap-2 sm:grid-cols-3"><select name="portalKind" className="input" aria-label="Portal">{Object.entries(w.portalKinds).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select><input name="name" required placeholder="Name (MAT — sales tax)" className="input" /><input name="portalUrl" placeholder="https:// (blank = standard address)" className="input" /><select name="accessMethod" className="input" aria-label="Access method"><option value="">Access method…</option>{ACCESS_METHODS.map((m) => <option key={m}>{m}</option>)}</select><input name="accessReference" placeholder="Access reference (password-manager item name)" className="input" /><select name="firmAccountId" className="input" aria-label="Firm account"><option value="">No firm-level account</option>{w.firmAccounts.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select><Button variant="secondary">Add portal</Button></ActionForm>}
            <h3 className="mt-4 font-semibold">Authorizations on file</h3>
            <ul className="text-sm">{e.authorizations.map((z) => <li key={z.id}>{z.formType} · {z.status} · effective {fmtD(z.effectiveDate)} · expires {fmtD(z.expiresAt)}{z.documentId && docsById.get(z.documentId) && <> · {docsById.get(z.documentId)!.document.title}</>}</li>)}{!e.authorizations.length && <li className="text-slate-600">None recorded.</li>}</ul>
            {manage && <ActionForm action={A.addAuthorizationAction.bind(null, e.id)} resetOnSuccess className="mt-2 grid gap-2 sm:grid-cols-5"><input name="formType" required placeholder="2848 / 2848A / 8821" className="input" /><select name="documentId" className="input" aria-label="Document"><option value="">No document</option>{e.documents.filter((d) => d.kind === "AUTHORIZATION").map((d) => <option key={d.documentId} value={d.documentId}>{d.document.title}</option>)}</select><input type="date" name="effectiveDate" className="input" aria-label="Effective" /><input type="date" name="expiresAt" className="input" aria-label="Expires" /><Button variant="secondary">Add</Button></ActionForm>}
          </section>
        </Card>

        <Card title="Obligations" actions={manage ? <span className="flex flex-wrap gap-2"><ActionForm action={A.applyTemplateAction.bind(null, e.id)} className="flex gap-2"><select name="template" className="input" aria-label="Industry template">{templates.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select><Button variant="secondary">Apply template</Button></ActionForm><ActionForm action={A.generateAction.bind(null, e.id)}><Button>Generate obligations</Button></ActionForm></span> : undefined}>
          <section id="obligations" data-testid="obligations">
            <p className="mb-3 text-sm text-slate-600">Proposed obligations need Tabitha&apos;s approval before their periods, prep tasks and reminders start. Dates labeled <NeedsVerification /> are not confirmed.</p>
            <ul className="divide-y divide-ivory-200">
              {e.obligations.map((o) => (
                <li key={o.id} id={`obligation-${o.id}`} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold">{o.title}</p>
                      <p className="text-xs text-slate-600">{o.jurisdictionName} · {CATEGORY_LABELS[o.category] ?? o.category} · {LABEL[o.frequency] ?? o.frequency} · {o.dueRuleDescription}{o.rule && <> · rule v{o.rule.version}</>}{o.clientApprovalRequired && " · client approval required"}{o.clientVisible && " · client-visible"}</p>
                      {o.status === "PROPOSED" && <p className="text-xs">Next due (preview, not confirmed): <strong>{fmtD(previews.get(o.id) ?? null)}</strong></p>}
                    </div>
                    <span className="flex flex-wrap items-center gap-2"><Badge tone={OBLIGATION_STATUS[o.status as keyof typeof OBLIGATION_STATUS]?.tone ?? "gray"}>{OBLIGATION_STATUS[o.status as keyof typeof OBLIGATION_STATUS]?.label ?? o.status}</Badge>{o.verification !== "VERIFIED" && <NeedsVerification />}{o.filingAccount && <a href={o.filingAccount.portalUrl} target="_blank" rel="noopener noreferrer" className="text-xs underline">Open portal</a>}</span>
                  </div>
                  {o.verifyItems.length > 0 && <details className="mt-1 text-sm"><summary className="cursor-pointer text-amber-900">What must be verified ({o.verifyItems.length})</summary><ul className="mt-1 list-disc pl-5 text-slate-700">{o.verifyItems.map((v) => <li key={v}>{v}</li>)}</ul></details>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {owner && (o.status === "PROPOSED" || o.status === "SUSPENDED" || o.status === "INACTIVE") && <ActionForm action={A.activateAction.bind(null, o.id, e.id)} className="flex items-center gap-2"><input type="date" name="startDate" className="input w-40" aria-label="Start date" title="Track periods due on or after" /><Button className="min-h-8 px-3 py-1 text-xs">Approve &amp; activate</Button></ActionForm>}
                    {owner && o.status !== "CLOSED" && <ActionForm action={A.obligationStatusAction.bind(null, o.id, e.id)} className="flex items-center gap-2"><select name="status" className="input w-36" aria-label="Change status"><option value="SUSPENDED">Suspend</option><option value="CLOSED">Close account</option><option value="INACTIVE">Deactivate</option></select><input name="reason" required placeholder="Reason" className="input w-40" /><Button variant="secondary" className="min-h-8 px-3 py-1 text-xs">Apply</Button></ActionForm>}
                    {manage && (
                      <details className="text-sm"><summary className="cursor-pointer underline">Edit handling</summary>
                        <ActionForm action={A.editObligationAction.bind(null, o.id, e.id)} className="mt-2 grid gap-2 sm:grid-cols-3">
                          <select name="assignedStaffId" defaultValue={o.assignedStaffId ?? ""} className="input" aria-label="Assigned staff"><option value="">Assigned: owner</option>{w.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                          <select name="reviewerId" defaultValue={o.reviewerId ?? ""} className="input" aria-label="Reviewer"><option value="">Reviewer: owner</option>{w.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                          <select name="filingAccountId" defaultValue={o.filingAccountId ?? ""} className="input" aria-label="Portal"><option value="">No portal link</option>{e.filingAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
                          <select name="serviceType" defaultValue={o.serviceType ?? ""} className="input" aria-label="Service"><option value="">No contracted service</option>{SERVICES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
                          <input name="accessReference" defaultValue={o.accessReference ?? ""} placeholder="Access reference" className="input" />
                          <input name="prepLeadDays" type="number" min={0} max={60} defaultValue={o.prepLeadDays} className="input" aria-label="Prep lead days" />
                          {o.status === "PROPOSED" && <select name="frequency" defaultValue={o.frequency} className="input" aria-label="Frequency">{Object.entries(LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
                          <label className="flex items-center gap-2"><input type="checkbox" name="clientApprovalRequired" defaultChecked={o.clientApprovalRequired} /> Client approval required</label>
                          <label className="flex items-center gap-2"><input type="checkbox" name="clientVisible" defaultChecked={o.clientVisible} /> Client-visible</label>
                          <Button variant="secondary">Save</Button>
                        </ActionForm>
                      </details>
                    )}
                  </div>
                </li>
              ))}
              {!e.obligations.length && <li className="py-3 text-sm text-slate-600">No obligations yet. Complete the profile and press Generate obligations.</li>}
            </ul>
            {owner && (
              <details className="mt-3 rounded-lg border border-ivory-200 p-3 text-sm"><summary className="cursor-pointer font-semibold">Add a custom obligation (owner)</summary>
                <ActionForm action={A.customObligationAction.bind(null, e.id)} className="mt-2 grid gap-2 sm:grid-cols-3">
                  <input name="title" required placeholder="Title" className="input" /><input name="formName" required placeholder="Form" className="input" /><input name="jurisdictionName" required placeholder="Agency / jurisdiction" className="input" />
                  <select name="jurisdictionLevel" className="input" aria-label="Level">{["FEDERAL", "STATE", "COUNTY", "CITY"].map((l) => <option key={l}>{l}</option>)}</select>
                  <select name="category" className="input" aria-label="Category">{Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                  <select name="frequency" className="input" aria-label="Frequency">{Object.entries(LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                  <input name="dueRuleCode" required placeholder="Due code (DOM:20:1, EOM:1, FIXED:01-31:1)" className="input" />
                  <select name="weekendRule" className="input" aria-label="Weekend rule">{Object.entries(WEEKEND_RULES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                  <input type="date" name="startDate" className="input" aria-label="Start" />
                  <label className="flex items-center gap-2"><input type="checkbox" name="clientApprovalRequired" /> Client approval required</label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="verified" /> I verified the due date at the official source</label>
                  <Button>Add &amp; activate</Button>
                </ActionForm>
              </details>
            )}
          </section>
        </Card>

        <Card title="Filing calendar">
          <section id="calendar" data-testid="entity-calendar">
            {e.periods.length ? <ul className="divide-y divide-ivory-200 text-sm">{e.periods.map((p) => { const o = e.obligations.find((x) => x.id === p.obligationId); return <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><span><strong>{fmtD(p.extendedDue ?? p.adjustedDue)}</strong>{p.dueCertainty !== "CONFIRMED" && <> <NeedsVerification /></>} · {o?.formName} · {p.periodKey}{p.kind === "AMENDED" ? " (amended)" : ""} · prep by {fmtD(p.prepDeadline)}</span><span className="flex items-center gap-2"><StatusBadge status={clientStatus(p)} /><Badge tone={p.paymentStatus === "PAID" ? "green" : "gray"}>{p.paymentStatus.replace("_", " ").toLowerCase()}</Badge><Link href={`/compliance/periods/${p.id}`} className="font-semibold underline">Open</Link></span></li>; })}</ul> : <p className="text-sm text-slate-600">No periods yet — they appear when an obligation is approved.</p>}
          </section>
        </Card>

        <Card title="Tax & Compliance folder (evidence)">
          <section id="documents">
            <ul className="mb-3 divide-y divide-ivory-200 text-sm">{e.documents.map((d) => <li key={d.id} className="py-1.5">{d.document.title} · {DOC_KINDS[d.kind as keyof typeof DOC_KINDS] ?? d.kind}{d.periodId && <> · <Link className="underline" href={`/compliance/periods/${d.periodId}`}>period</Link></>} · {fmtD(d.document.createdAt)}{d.publishedAt && <Badge tone="green" className="ml-1">Released to client</Badge>}{d.document.scanStatus !== "CLEAN" && <Badge tone="amber" className="ml-1">Not scanned</Badge>}</li>)}{!e.documents.length && <li className="py-1.5 text-slate-600">No documents yet.</li>}</ul>
            {manage && <ActionForm action={A.uploadComplianceDocAction.bind(null, e.id, null)} resetOnSuccess className="flex flex-wrap gap-2"><select name="kind" className="input w-auto" aria-label="Kind">{Object.entries(DOC_KINDS).filter(([k]) => ["AUTHORIZATION", "EXEMPTION", "OTHER"].includes(k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><input name="title" placeholder="Title" className="input w-56" /><input type="file" name="file" required accept="application/pdf,image/png,image/jpeg" className="text-sm" /><Button variant="secondary">Upload</Button></ActionForm>}
          </section>
        </Card>

        <Card title="Approvals">
          <section id="approvals">
            {e.periods.flatMap((p) => p.versions.map((v) => ({ p, v }))).length ? <ul className="divide-y divide-ivory-200 text-sm">{e.periods.flatMap((p) => p.versions.map((v) => <li key={v.id} className="py-1.5"><Link href={`/compliance/periods/${p.id}`} className="underline">{p.periodKey}</Link> · version {v.version} · {v.status}{v.invalidatedReason && ` (${v.invalidatedReason})`} · {v.approvals.map((a) => `${a.decision === "APPROVED" ? "Approved" : "Changes requested"} by ${a.signerName} ${a.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC`).join("; ") || "no decision"}</li>))}</ul> : <p className="text-sm text-slate-600">No return versions yet.</p>}
          </section>
        </Card>

        <Card title="History">
          <section id="history"><ul className="text-xs text-slate-700">{w.history.map((h) => <li key={h.id} className="py-0.5">{h.createdAt.toISOString().slice(0, 16).replace("T", " ")} · {h.actor?.name ?? "System / client"} · {h.action.replace("compliance.", "")}</li>)}</ul></section>
        </Card>
      </div>
    </>
  );
}
