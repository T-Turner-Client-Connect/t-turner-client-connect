import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import {
  addItemAction, addOfficerAction, applyTemplateAction, assignPackageAction, irsEventAction, itemStatusAction, itemUploadAction, openPortfolioAction, releaseFileAction, removeOfficerAction, resendNoticeAction, savePortfolioAction,
} from "@/app/actions/nonprofit-portfolio";
import { requireUser } from "@/lib/auth/session";
import { sendAgreementAction } from "@/app/actions/service-agreements";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { prisma } from "@/lib/prisma";
import { downloadToken } from "@/lib/services/documents";
import { AG_STATUS, annualDeadline, CATEGORIES, classifications, DONE, packagePrice, packages, SECTIONS, type Section, IRS_EVENTS, irsStatus, ITEM_STATUS, ORIGINS, portfolio, releaseNotices, SAM_STATUS, stateTemplate, type ItemStatus } from "@/lib/services/nonprofit-portfolio";
import { FILING_SERVICE } from "@/lib/services/nonprofits";
import { SERVICE_STATUS, serviceGate } from "@/lib/services/service-agreements";
import { STATES } from "@/lib/resources/catalog";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Nonprofit Portfolio" };

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");

export default async function NonprofitPortfolioPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ state?: string }> }) {
  await connection();
  const user = await requireUser();
  const { orgId } = await params;
  const org = await prisma.client.findUnique({ where: { id: orgId }, select: { id: true, displayName: true, clientType: true } });
  if (!org || org.clientType !== "NONPROFIT") notFound();
  const p = await portfolio(orgId);
  if (!p) {
    return (
      <>
        <PageHeader title={`${org.displayName} — Nonprofit Portfolio`} />
        <Card title="No portfolio yet">
          <p className="mb-3 text-sm">Open a portfolio to track this organization&apos;s formation, federal and state filings, documents and grant readiness.</p>
          <ActionForm action={openPortfolioAction.bind(null, orgId)}><Button type="submit">Open Nonprofit Portfolio</Button></ActionForm>
        </Card>
      </>
    );
  }
  const sp = await searchParams;
  const [cls, staff, notices, history] = await Promise.all([
    classifications(true),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    releaseNotices(orgId),
    prisma.auditLog.findMany({ where: { clientId: orgId, action: { startsWith: "nonprofit." } }, orderBy: { createdAt: "desc" }, take: 30, include: { actor: { select: { name: true } } } }),
  ]);
  const chosenState = sp.state ?? p.formationState ?? "AL";
  const tpl = await stateTemplate(chosenState);
  const current = cls.find((c) => c.key === p.classification);
  const applicable = p.items.filter((i) => i.status !== "NOT_APPLICABLE");
  const done = applicable.filter((i) => DONE.includes(i.status as ItemStatus)).length;
  const deadline = annualDeadline(p.client);
  const docs = await prisma.document.findMany({ where: { id: { in: p.items.flatMap((i) => i.files.map((f) => f.documentId)) } }, select: { id: true, title: true, scanStatus: true, visibility: true, file: { select: { originalName: true } } } });
  const staffName = new Map(staff.map((s) => [s.id, s.name]));
  const pkgs = await packages();
  const assigned = p.packageKey ? await prisma.nonprofitPackage.findUnique({ where: { key: p.packageKey } }) : null;
  const svc = p.serviceId ? await prisma.clientService.findUnique({ where: { id: p.serviceId }, include: { agreements: true } }) : null;
  const gate = svc ? await serviceGate(svc) : null;
  const packageDraft = svc?.agreements.filter((a) => a.status === "DRAFT").sort((a, b) => b.version - a.version)[0] ?? null;
  const approver = await isReportApprover(user);
  const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

  return (
    <>
      <PageHeader
        title={`${p.legalName || org.displayName} — Nonprofit Portfolio`}
        subtitle="Its own organization record. Formation, federal and state filings, documents and grant readiness in one place."
        actions={<Link className="text-sm underline" href={`/clients/${orgId}`}>Open organization record</Link>}
      />
      <div className="mb-4 rounded-xl bg-white p-4" data-testid="np-progress">
        <div className="mb-1 flex justify-between text-sm font-semibold"><span>Progress</span><span>{done} of {applicable.length}</span></div>
        <div className="h-2 rounded-full bg-ivory-200"><div className="h-2 rounded-full bg-emerald-600" style={{ width: `${applicable.length ? (done / applicable.length) * 100 : 0}%` }} /></div>
      </div>

      <Card title="Formation package" className="mb-4">
        <div className="text-sm" data-testid="np-package">
          {assigned ? (
            <p className="mb-2">
              <strong>{assigned.name}</strong> · government filing fees {p.govFeesMode === "INCLUDED" ? "included in the price" : "added to the price"}
              {svc && <> · <Link className="underline" href={`/clients/${orgId}?tab=services`}>agreement: {SERVICE_STATUS[svc.status]}</Link></>}
              {/* The package's pricing agreement is sent from here (the client page shows earlier pricing agreements read-only). */}
              {packageDraft && (approver
                ? <ActionForm action={sendAgreementAction.bind(null, orgId, packageDraft.id)} className="mt-2"><Button type="submit" variant="gold">Send package agreement to the client</Button></ActionForm>
                : <span className="mt-1 block text-xs text-slate-600">Tabitha sends the package agreement to the client.</span>)}
              {assigned.grantDisclaimer && <> · <Badge tone="gold">Includes grant disclaimer</Badge></>}
            </p>
          ) : <p className="mb-2 text-slate-700">No package assigned. Assigning one adds its documents to the checklist and prepares the pricing agreement.</p>}
          {gate && !gate.ok && <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900" data-testid="package-gate">Package work can&apos;t begin yet: {gate.reason}</p>}
          <ActionForm action={assignPackageAction.bind(null, orgId)} className="flex flex-wrap items-end gap-2">
            <Field label={assigned ? "Change package" : "Package"}>
              <select className="input" name="packageKey" defaultValue={p.packageKey ?? ""} required>
                <option value="" disabled>Choose</option>
                {pkgs.map((k) => <option key={k.key} value={k.key}>{k.name} — {k.priceNote ? `${k.priceNote} ` : ""}{usd(packagePrice(k, p.formationState))}{k.govFeesMode === "INCLUDED" ? " (fees included)" : " + government fees"}</option>)}
              </select>
            </Field>
            <Field label="Price (optional)" hint="Adjust for filings and complexity."><input className="input w-32" name="price" inputMode="decimal" placeholder="Package price" /></Field>
            <Field label="Government filing fees" hint="When fees are added to the price."><input className="input w-32" name="govFee" inputMode="decimal" placeholder="$0.00" /></Field>
            <Button type="submit" variant="secondary">{assigned ? "Change package" : "Assign package"}</Button>
          </ActionForm>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Organization">
          <ActionForm action={savePortfolioAction.bind(null, orgId)} className="grid gap-2 text-sm sm:grid-cols-2">
            <Field label="Legal name"><input className="input" name="legalName" defaultValue={p.legalName ?? ""} /></Field>
            <Field label="State of formation"><select className="input" name="formationState" defaultValue={p.formationState ?? ""}><option value="">—</option>{STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></Field>
            <Field label="Formation date"><input className="input" type="date" name="formationDate" defaultValue={day(p.formationDate)} /></Field>
            <Field label="EIN"><input className="input" name="ein" defaultValue={p.ein ?? ""} placeholder="12-3456789" /></Field>
            <Field label="Secretary of State entity number"><input className="input" name="sosEntityNumber" defaultValue={p.sosEntityNumber ?? ""} /></Field>
            <Field label="State filing date"><input className="input" type="date" name="sosFilingDate" defaultValue={day(p.sosFilingDate)} /></Field>
            <Field label="Registered agent"><input className="input" name="registeredAgent" defaultValue={p.registeredAgent ?? ""} /></Field>
            <Field label="Registered agent address"><input className="input" name="registeredAgentAddress" defaultValue={p.registeredAgentAddress ?? ""} /></Field>
            <Field label="Federal classification" className="sm:col-span-2">
              <select className="input" name="classification" defaultValue={p.classification ?? ""}><option value="">Not decided</option>{cls.filter((c) => c.active || c.key === p.classification).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
            </Field>
            <Field label="Attorney General charitable registration"><select className="input" name="agStatus" defaultValue={p.agStatus ?? ""}><option value="">—</option>{Object.entries(AG_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="AG renewal date"><input className="input" type="date" name="agRenewalDate" defaultValue={day(p.agRenewalDate)} /></Field>
            <Field label="AG note (exemption and how it was confirmed)" className="sm:col-span-2"><input className="input" name="agNote" defaultValue={p.agNote ?? ""} /></Field>
            <Field label="SAM.gov registration"><select className="input" name="samStatus" defaultValue={p.samStatus ?? ""}><option value="">—</option>{Object.entries(SAM_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Unique Entity ID (UEI)"><input className="input" name="uei" defaultValue={p.uei ?? ""} /></Field>
            <Field label="SAM.gov registration expires"><input className="input" type="date" name="samExpiresOn" defaultValue={day(p.samExpiresOn)} /></Field>
            <Field label="Mission" className="sm:col-span-2"><textarea className="input" name="mission" rows={2} defaultValue={p.mission ?? ""} /></Field>
            <Field label="Programs" className="sm:col-span-2"><textarea className="input" name="programs" rows={2} defaultValue={p.programs ?? ""} /></Field>
            <div><Button type="submit" variant="secondary">Save</Button></div>
          </ActionForm>
        </Card>

        <div className="space-y-4">
          <Card title="Federal tax exemption">
            <div className="space-y-2 text-sm" data-testid="np-classification">
              {current ? (
                <>
                  <p><strong>{current.label}</strong> {current.verifiedAt ? <Badge tone="green">Verified {fmtDate(current.verifiedAt)}</Badge> : <Badge tone="amber">Not verified</Badge>}</p>
                  <p>{current.process}</p>
                  {current.sourceUrl && <p><a className="underline" href={current.sourceUrl} target="_blank" rel="noopener noreferrer">IRS source</a></p>}
                </>
              ) : <p>Choose the classification first — not every category uses Form 1023.</p>}
              <p>IRS application status: <strong data-testid="irs-status">{(() => { const s = irsStatus(p.irsEvents); return s ? IRS_EVENTS[s as keyof typeof IRS_EVENTS] : "Not submitted"; })()}</strong></p>
              <ul className="text-xs text-slate-700">{p.irsEvents.map((e) => <li key={e.id}>{fmtDate(e.at)} — {IRS_EVENTS[e.kind as keyof typeof IRS_EVENTS]}{e.reference ? ` · ${e.reference}` : ""}{e.note ? ` · ${e.note}` : ""}</li>)}</ul>
              <ActionForm action={irsEventAction.bind(null, orgId)} className="grid gap-2 sm:grid-cols-2" resetOnSuccess>
                <Field label="IRS step"><select className="input" name="kind" defaultValue="" required><option value="" disabled>Choose</option>{Object.entries(IRS_EVENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label="Date (Central)"><input className="input" type="datetime-local" name="at" required /></Field>
                <Field label="Reference"><input className="input" name="reference" /></Field>
                <Field label="Note"><input className="input" name="note" /></Field>
                <div><Button type="submit" variant="secondary">Record</Button></div>
              </ActionForm>
            </div>
          </Card>

          <Card title="Board members and officers">
            <ul className="mb-2 divide-y divide-ivory-200 text-sm">
              {p.officers.map((o) => (
                <li key={o.id} className="flex items-center justify-between py-1.5">
                  <span>{o.name} · {o.role}{o.termEnd ? ` · term ends ${fmtDate(o.termEnd)}` : ""}</span>
                  <ActionForm action={removeOfficerAction.bind(null, orgId, o.id)} showSuccess={false}><Button type="submit" variant="ghost">Remove</Button></ActionForm>
                </li>
              ))}
              {p.officers.length === 0 && <li className="py-1.5 text-slate-600">None recorded.</li>}
            </ul>
            <ActionForm action={addOfficerAction.bind(null, orgId)} className="grid gap-2 sm:grid-cols-4" resetOnSuccess>
              <input className="input" name="name" placeholder="Name" aria-label="Name" required />
              <input className="input" name="role" placeholder="Role (e.g. President)" aria-label="Role" required />
              <input className="input" type="date" name="termEnd" aria-label="Term ends" />
              <Button type="submit" variant="secondary">Add</Button>
            </ActionForm>
          </Card>

          <Card title="Annual compliance">
            <div className="text-sm" data-testid="np-annual">
              <p>TTurner handles its annual filings: <strong>{p.client.nonprofitProfile?.filingService ? FILING_SERVICE[p.client.nonprofitProfile.filingService as keyof typeof FILING_SERVICE] : "Not recorded"}</strong> — reminders and filing tasks only when Yes.</p>
              {deadline ? <p>{deadline.form} for {deadline.taxYear} due {deadline.due} ({deadline.days} days).</p> : <p>Deadline unknown until the fiscal year-end and required return are recorded.</p>}
              <p className="mt-1"><Link className="underline" href={`/nonprofits#np-${orgId}`}>Open in Nonprofit Filings</Link></p>
            </div>
          </Card>
        </div>
      </div>

      <Card title="Document checklist" className="mt-4">
        <form className="mb-3 flex flex-wrap items-end gap-2 text-sm" method="get">
          <Field label="State requirements"><select className="input" name="state" defaultValue={chosenState}>{STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></Field>
          <Button type="submit" variant="ghost">Show</Button>
        </form>
        <div className="mb-3 rounded-lg bg-ivory-50 p-3 text-sm" data-testid="state-template">
          <p className="mb-1 font-semibold">{tpl.name}: {tpl.verifiedAt ? <Badge tone="green">Verified {fmtDate(tpl.verifiedAt)}</Badge> : <Badge tone="amber">{tpl.saved ? "Draft — not verified" : "General baseline — not specific to this state, not verified"}</Badge>}</p>
          <ul className="list-disc pl-5 text-xs">{tpl.items.map((i) => <li key={i.key}>{i.label}{i.required ? "" : " (only if it applies — review)"}{i.note ? ` — ${i.note}` : ""}</li>)}</ul>
          <ActionForm action={applyTemplateAction.bind(null, orgId)} className="mt-2"><input type="hidden" name="state" value={chosenState} /><Button type="submit" variant="secondary">Add these to the checklist</Button></ActionForm>
        </div>

        <div data-testid="np-checklist">
        {(Object.keys(SECTIONS) as Section[]).filter((sec) => p.items.some((i) => i.section === sec)).map((sec) => (
        <div key={sec} className="mb-4">
        <h3 className="mb-1 border-b border-ivory-200 pb-1 font-serif text-lg text-navy-900">{SECTIONS[sec]}</h3>
        <ul className="divide-y divide-ivory-200">
          {p.items.filter((i) => i.section === sec).map((i) => (
            <li key={i.id} className="py-3 text-sm" data-item={i.label}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span><strong>{i.label}</strong> {i.deliverable && <Badge tone="gold">Package deliverable</Badge>} {i.requirement && <Badge tone="gray">Government requirement</Badge>} <span className="text-xs text-slate-600">· {CATEGORIES[i.category as keyof typeof CATEGORIES]}{i.responsibleId ? ` · ${staffName.get(i.responsibleId) ?? ""}` : ""}{i.completedAt ? ` · completed ${fmtDate(i.completedAt)}` : ""}{i.filingReference ? ` · ref ${i.filingReference}` : ""}</span></span>
                <span data-testid="item-status"><Badge tone={DONE.includes(i.status as ItemStatus) ? "green" : i.status === "NOT_APPLICABLE" ? "gray" : "amber"}>{ITEM_STATUS[i.status as ItemStatus]}</Badge></span>
              </div>
              <div className="grid gap-2 lg:grid-cols-2">
                <ActionForm action={itemStatusAction.bind(null, orgId, i.id)} className="flex flex-wrap items-end gap-2" showSuccess={false}>
                  <select className="input w-48" name="status" defaultValue={i.status} aria-label="Status">{Object.entries(ITEM_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                  <select className="input w-40" name="responsibleId" defaultValue={i.responsibleId ?? ""} aria-label="Responsible"><option value="">Responsible</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                  <input className="input w-36" name="filingReference" defaultValue={i.filingReference ?? ""} placeholder="Filing reference" aria-label="Filing reference" />
                  <Button type="submit" variant="ghost">Update</Button>
                </ActionForm>
                <ActionForm action={itemUploadAction.bind(null, orgId, i.id)} className="flex flex-wrap items-end gap-2" resetOnSuccess>
                  <select className="input w-52" name="origin" defaultValue="" required aria-label="Kind of document"><option value="" disabled>Kind of document</option>{Object.entries(ORIGINS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                  <input className="input w-56" type="file" name="file" accept="application/pdf,image/png,image/jpeg,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" required aria-label="File" />
                  <Button type="submit" variant="secondary">Upload</Button>
                </ActionForm>
              </div>
              {i.files.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs" data-testid="item-files">
                  {i.files.map((f) => {
                    const doc = docs.find((x) => x.id === f.documentId);
                    return (
                      <li key={f.id} className="flex flex-wrap items-center gap-2">
                        <a className="underline" href={`/api/documents/${downloadToken(f.documentId, { staffId: user.id })}`} target="_blank" rel="noopener">{doc?.file.originalName ?? "file"}</a>
                        <Badge tone={f.origin === "INTERNAL_DRAFT" ? "gray" : f.origin === "GOVERNMENT_ISSUED" ? "gold" : "green"}>{ORIGINS[f.origin as keyof typeof ORIGINS]}</Badge>
                        <span>uploaded {fmtDateTime(f.createdAt)}</span>
                        {f.releasedAt ? (
                          <>
                            <Badge tone="green">Released {fmtDateTime(f.releasedAt)}</Badge>
                            <ActionForm action={resendNoticeAction.bind(null, orgId, f.id)}><Button type="submit" variant="ghost">Resend notice</Button></ActionForm>
                          </>
                        ) : f.origin === "INTERNAL_DRAFT" ? (
                          <span className="text-slate-600">Drafts are never released.</span>
                        ) : doc?.scanStatus !== "CLEAN" ? (
                          <span className="text-amber-800">Waiting for the malware scan</span>
                        ) : (
                          <ActionForm action={releaseFileAction.bind(null, orgId, f.id)} confirm="Release this document to the client's portfolio and email them a sign-in link?"><Button type="submit" variant="gold">Release to client</Button></ActionForm>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          ))}
        </ul>
        </div>
        ))}
        {p.items.length === 0 && <p className="py-3 text-sm text-slate-600">Assign a package or add the state requirements above, or add items below.</p>}
        </div>
        <ActionForm action={addItemAction.bind(null, orgId)} className="mt-3 flex flex-wrap items-end gap-2 text-sm" resetOnSuccess>
          <Field label="Add a document to this portfolio"><input className="input w-72" name="label" required /></Field>
          <Field label="Category"><select className="input" name="category" defaultValue="OTHER">{Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Section"><select className="input" name="section" defaultValue="OTHER">{Object.entries(SECTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Button type="submit" variant="secondary">Add</Button>
        </ActionForm>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Client notifications">
          {notices.length === 0 ? <p className="text-sm text-slate-600">None yet.</p> : (
            <ul className="space-y-1 text-xs" data-testid="np-notices">{notices.map((n) => <li key={n.id}>{fmtDateTime(n.createdAt)} — {n.portalUser.email} — <strong>{n.status}</strong> — {n.statusDetail}</li>)}</ul>
          )}
          <Notice tone="info">Emails contain a sign-in link only. Documents are never attached.</Notice>
        </Card>
        <Card title="Activity">
          <ul className="space-y-1 text-xs">{history.map((h) => <li key={h.id}>{fmtDateTime(h.createdAt)} — {h.action.replace("nonprofit.", "").replace(/_/g, " ")}{h.actor ? ` — ${h.actor.name}` : ""}</li>)}</ul>
        </Card>
      </div>
    </>
  );
}
