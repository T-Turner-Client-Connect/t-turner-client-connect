import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import {
  recordAuthorizationAction, revealEinAction, revokeAuthorizationAction, saveAccountAction, saveBillingAction, saveBillingNotesAction, saveBusinessInfoAction,
} from "@/app/actions/bookkeeping-clients";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { BASIS } from "@/lib/bookkeeping-periods";
import { ENTITY_TYPES } from "@/lib/tax/deadlines";
import { MONTHS } from "@/lib/services/bookkeeping";
import { FREQUENCIES, PAYROLL_FREQUENCIES } from "@/lib/services/bookkeeping-clients";
import {
  ACCESS_STATUSES, ACCOUNT_TYPES, AUTH_METHODS, BILLING_STATUSES, billingView, maskEin, PAYROLL_ACCESS, PAYROLL_REPORT_TYPES,
} from "@/lib/services/bookkeeping-profile";
import { fmtDate } from "@/lib/format";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { businessFamily } from "@/lib/services/related-businesses";
import { SquareBillingPanel, SquareConnectionStatus } from "@/components/square-billing-panel";
import { squareHealth } from "@/lib/services/square-health";

export const metadata = { title: "Business profile" };

const iso = (d: Date | null | undefined) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "");
const money = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));

export default async function BusinessProfilePage({ params }: { params: Promise<{ clientId: string }> }) {
  await connection();
  const user = await requireUser();
  const { clientId } = await params;
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, displayName: true, businessName: true, email: true, phone: true, entityType: true, fiscalYearEnd: true, assignedTo: { select: { name: true } }, bookkeepingProfile: true, bookkeepingAccounts: { orderBy: [{ active: "desc" }, { institution: "asc" }] } },
  });
  if (!client) notFound();
  const profile = client.bookkeepingProfile;
  const billing = await billingView(user, clientId);
  const evidenceDocs = billing.allowed ? await prisma.document.findMany({ where: { clientId, deletedAt: null, category: { not: "IDENTITY" } }, select: { id: true, title: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 40 }) : [];
  const [approver, family, health] = billing.allowed ? await Promise.all([isReportApprover(user), businessFamily(clientId), squareHealth()]) : [false, null, null];
  // Businesses (and the owner's Personal record) that could share this client's Square bill.
  const onBill = new Set(billing.allowed ? billing.squareBilling.arrangement?.members.map((m) => m.clientId) ?? [] : []);
  const addable = family ? [family.person, ...family.businesses].filter((c): c is NonNullable<typeof c> => !!c && !onBill.has(c.id)) : [];
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 8 }, (_, i) => thisYear + 1 - i);

  return (
    <>
      <p className="mb-2 text-sm"><Link className="underline" href={`/bookkeeping/${clientId}`}>← {client.displayName}&apos;s bookkeeping workspace</Link></p>
      <PageHeader
        title={`${profile?.legalName || client.displayName} — Business profile`}
        subtitle={<>{profile ? `${FREQUENCIES[profile.frequency as keyof typeof FREQUENCIES]} reporting` : "Not a Bookkeeping Client yet"} · Assigned: {client.assignedTo?.name ?? "unassigned"} · Kept separate from the Owner&apos;s Office</>}
      />
      {!profile ? (
        <Notice tone="warn" title="Not a Bookkeeping Client yet">Use <Link className="underline" href={`/bookkeeping/new?client=${clientId}`}>Add Bookkeeping Client</Link> first.</Notice>
      ) : (
        <div className="space-y-4">
          <Card title="Business information">
            <ActionForm action={saveBusinessInfoAction.bind(null, clientId)} className="grid gap-3 sm:grid-cols-3" showSuccess>
              <Field label="Legal business name"><input className="input" name="legalName" defaultValue={profile.legalName ?? client.businessName ?? ""} /></Field>
              <Field label="DBA (doing business as)"><input className="input" name="dba" defaultValue={profile.dba ?? ""} /></Field>
              <Field label="Entity type">
                <select className="input" name="entityType" defaultValue={client.entityType ?? ""}><option value="">—</option>{Object.entries(ENTITY_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </Field>
              <Field label="EIN" hint={profile.einLast4 ? `On file: ${maskEin(profile.einLast4)}. Leave blank to keep it.` : "9 digits. Stored encrypted; shown masked."}>
                <input className="input" name="ein" autoComplete="off" inputMode="numeric" placeholder={profile.einLast4 ? maskEin(profile.einLast4)! : "12-3456789"} data-testid="ein-input" />
              </Field>
              <Field label="Business start date"><input className="input" type="date" name="businessStartDate" defaultValue={iso(profile.businessStartDate)} /></Field>
              <Field label="Accounting basis" hint="Shown on every report">
                <select className="input" name="accountingBasis" defaultValue={profile.accountingBasis ?? ""}><option value="">—</option>{Object.entries(BASIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </Field>
              <Field label="Business address"><input className="input" name="businessAddress1" defaultValue={profile.businessAddress1 ?? ""} /></Field>
              <Field label="Address line 2"><input className="input" name="businessAddress2" defaultValue={profile.businessAddress2 ?? ""} /></Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label="City"><input className="input" name="businessCity" defaultValue={profile.businessCity ?? ""} /></Field>
                <Field label="State"><input className="input" name="businessState" maxLength={2} defaultValue={profile.businessState ?? ""} /></Field>
                <Field label="ZIP"><input className="input" name="businessPostalCode" defaultValue={profile.businessPostalCode ?? ""} /></Field>
              </div>
              <Field label="Business email"><input className="input" type="email" name="businessEmail" defaultValue={profile.businessEmail ?? ""} /></Field>
              <Field label="Contact person"><input className="input" name="contactName" defaultValue={profile.contactName ?? ""} /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Title"><input className="input" name="contactTitle" placeholder="e.g. Member" defaultValue={profile.contactTitle ?? ""} /></Field>
                <Field label="Phone"><input className="input" type="tel" name="contactPhone" defaultValue={profile.contactPhone ?? ""} /></Field>
              </div>
              <Field label="Working tax/accounting year" hint="Earlier years stay available in the workspace">
                <select className="input" name="workingYear" defaultValue={profile.workingYear ?? ""}><option value="">—</option>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>
              </Field>
              <Field label="Fiscal year ends">
                <select className="input" name="fiscalYearEnd" defaultValue={client.fiscalYearEnd ?? ""}><option value="">December (calendar year)</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
              </Field>
              <Field label="Reporting schedule" hint="Change it in the workspace's Service details"><input className="input" readOnly value={FREQUENCIES[profile.frequency as keyof typeof FREQUENCIES]} /></Field>

              <fieldset className="rounded-xl border border-ivory-200 p-3 sm:col-span-3">
                <legend className="px-1 text-sm font-semibold">Payroll</legend>
                {profile.payroll ? (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <p className="text-sm">Does this business have payroll? <strong>Yes</strong> · {profile.payrollProvider ?? "provider not set"} · {profile.payrollFrequency ? PAYROLL_FREQUENCIES[profile.payrollFrequency as keyof typeof PAYROLL_FREQUENCIES] : "frequency not set"}</p>
                    <Field label="Payroll account access">
                      <select className="input" name="payrollAccessStatus" defaultValue={profile.payrollAccessStatus ?? ""}><option value="">—</option>{Object.entries(PAYROLL_ACCESS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                    </Field>
                    <div className="text-sm">
                      <p className="mb-1 font-semibold">Required monthly payroll reports</p>
                      {Object.entries(PAYROLL_REPORT_TYPES).map(([k, v]) => (
                        <label key={k} className="flex items-center gap-2"><input type="checkbox" name="payrollReports" value={k} defaultChecked={profile.payrollReports.includes(k)} /> {v}</label>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm">Does this business have payroll? <strong>No</strong>. Turn on &quot;Runs payroll&quot; in the workspace&apos;s Service details to add provider, frequency, access and required reports.</p>
                )}
              </fieldset>
              <div className="sm:col-span-3"><Button type="submit">Save business profile</Button></div>
            </ActionForm>
            {profile.einLast4 && user.role === "ADMIN" && (
              <ActionForm action={revealEinAction.bind(null, clientId)} className="mt-3">
                <Button type="submit" variant="ghost">Show full EIN (Admin — logged)</Button>
              </ActionForm>
            )}
          </Card>

          <Card title="Bank & credit-card accounts">
            <p className="mb-3 text-sm text-slate-600">
              Never save passwords, PINs, security answers or sign-in codes here. Ask the client to add us through the bank&apos;s <strong>accountant / delegated access</strong> (or an official connection where the bank offers one). When there&apos;s no access, upload the monthly statements to the workspace.
            </p>
            <ul className="divide-y divide-navy-100" data-testid="bk-accounts">
              {client.bookkeepingAccounts.map((a) => (
                <li key={a.id} className="py-3">
                  <details>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                      <strong>{a.nickname || a.institution}</strong> · {ACCOUNT_TYPES[a.accountType as keyof typeof ACCOUNT_TYPES]} {a.last4 && `****${a.last4}`}
                      <Badge tone={ACCESS_STATUSES[a.accessStatus as keyof typeof ACCESS_STATUSES].tone}>{ACCESS_STATUSES[a.accessStatus as keyof typeof ACCESS_STATUSES].label}</Badge>
                      {!a.active && <Badge tone="gray">Closed</Badge>}
                      {a.loginUrl && <a className="text-xs underline" href={a.loginUrl} target="_blank" rel="noopener noreferrer">Official sign-in page ↗</a>}
                    </summary>
                    <AccountForm clientId={clientId} account={a} />
                  </details>
                </li>
              ))}
              {client.bookkeepingAccounts.length === 0 && <li className="py-2 text-sm text-slate-600">No accounts yet.</li>}
            </ul>
            {/* Always shown, so the confirmation stays on screen after the first account is added. */}
            <div className="mt-3" data-testid="add-account">
              <h3 className="text-sm font-semibold">+ Add an account</h3>
              <AccountForm clientId={clientId} account={null} />
            </div>
          </Card>

          <Card title="Monthly bookkeeping billing">
            {!billing.allowed ? (
              <p className="text-sm text-slate-600" data-testid="billing-restricted">Billing and payment methods are managed by Tabitha.</p>
            ) : (
              <div className="space-y-4" data-testid="billing">
                {health && !billing.squareBilling.arrangement && <SquareConnectionStatus health={health} />}
                <SquareBillingPanel
                  clientId={clientId} sb={billing.squareBilling} approver={approver} addable={addable}
                  client={{ name: client.businessName || client.displayName, email: client.email, phone: client.phone }}
                  // Unlinked clients are searched in Square automatically (read only) — but only while the connection works.
                  autoSuggest={!billing.squareBilling.arrangement && health?.state === "WORKING"}
                  initialQuery={billing.square.customerId?.status === "UNVERIFIED" ? billing.square.customerId.id : undefined}
                  health={health} notes={billing.billing?.notes ?? null} notesAction={saveBillingNotesAction.bind(null, clientId)}
                />
                {billing.squareBilling.state === "NONE" ? (
                  <div className="space-y-3 rounded-xl border border-ivory-200 p-3" data-testid="manual-billing">
                    <p className="text-sm"><strong>Manually managed billing</strong> <Badge tone="gray">Not billed through Square</Badge> <span className="block text-xs text-slate-600">Only for clients who aren&apos;t billed through Square. If this client pays through Square, use “Mark as billed through Square” above and link them instead.</span></p>
                    <div className="grid gap-3 text-sm sm:grid-cols-2">
                      <p><span className="block text-xs uppercase tracking-wide text-slate-500">Card saved through the portal</span>{billing.square.card ? `${billing.square.card.brand} ****${billing.square.card.last4} · exp ${billing.square.card.expMonth}/${billing.square.card.expYear}` : "None saved"}</p>
                      <p><span className="block text-xs uppercase tracking-wide text-slate-500">Recurring charges</span>{billing.chargeAuthorized ? <Badge tone="green">Authorized</Badge> : <Badge tone="red">Not authorized</Badge>} <span className="block text-xs text-slate-600">A card on file alone never authorizes a charge.</span></p>
                    </div>
                    <ActionForm action={saveBillingAction.bind(null, clientId)} className="grid gap-3 sm:grid-cols-3">
                      <Field label="Monthly bookkeeping charge ($)"><input className="input" name="monthlyFee" inputMode="decimal" defaultValue={money(billing.billing?.monthlyFeeCents)} /></Field>
                      <Field label="Billing start date"><input className="input" type="date" name="billingStartDate" defaultValue={iso(billing.billing?.billingStartDate)} /></Field>
                      <Field label="Billing day of the month"><select className="input" name="billingDay" defaultValue={billing.billing?.billingDay ?? ""}><option value="">—</option>{Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}</select></Field>
                      <Field label="Office-recorded status (not from Square)"><select className="input" name="paymentStatus" defaultValue={billing.billing?.paymentStatus ?? "NOT_SET_UP"}>{Object.entries(BILLING_STATUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                      <Field label="Notes"><input className="input" name="notes" defaultValue={billing.billing?.notes ?? ""} /></Field>
                      <div className="sm:col-span-3"><Button type="submit" variant="secondary">Save billing</Button></div>
                    </ActionForm>
                  </div>
                ) : (
                  (billing.billing?.monthlyFeeCents != null || billing.billing?.billingDay != null || billing.billing?.billingStartDate || (billing.billing?.paymentStatus && billing.billing.paymentStatus !== "NOT_SET_UP") || billing.square.customerId?.status === "UNVERIFIED" || billing.square.customerId?.previousManual) && (
                    <details className="rounded-xl border border-dashed border-slate-300 p-3 text-sm" data-testid="manual-history">
                      <summary className="cursor-pointer text-slate-700">Earlier office-entered values — history only, not from Square</summary>
                      <p className="mt-1 text-xs text-slate-600">Kept for the record. They aren&apos;t verified, aren&apos;t used for billing, and are never shown as Square information.</p>
                      <ul className="mt-2 space-y-1 text-slate-700">
                        {billing.billing?.monthlyFeeCents != null && <li>Monthly charge typed by staff: ${money(billing.billing.monthlyFeeCents)}</li>}
                        {billing.billing?.billingStartDate && <li>Billing start date typed by staff: {fmtDate(billing.billing.billingStartDate)}</li>}
                        {billing.billing?.billingDay != null && <li>Billing day typed by staff: {billing.billing.billingDay}</li>}
                        {billing.billing?.paymentStatus && billing.billing.paymentStatus !== "NOT_SET_UP" && <li>Status chosen by staff: {BILLING_STATUSES[billing.billing.paymentStatus as keyof typeof BILLING_STATUSES]}</li>}
                        {billing.square.customerId?.status === "UNVERIFIED" && (
                          <li data-testid="manual-customer-id">“Square customer ID” typed by hand: {billing.square.customerId.id} <Badge tone="amber">Not verified</Badge>
                            {/^\d{3,8}$/.test(billing.square.customerId.id) && <span className="block text-xs">This looks like a Square <strong>recurring invoice series</strong> number (invoice numbers {billing.square.customerId.id}-R-…), not a customer ID. Find and link searches it to find the customer it bills.</span>}
                          </li>
                        )}
                        {billing.square.customerId?.previousManual && <li>Earlier hand-typed ID: {billing.square.customerId.previousManual} (replaced by the verified customer ID)</li>}
                      </ul>
                    </details>
                  )
                )}
                <div>
                  <h3 className="mb-1 text-sm font-semibold">Recurring-charge authorization</h3>
                  <ul className="mb-2 space-y-1 text-sm" data-testid="authorizations">
                    {billing.authorizations.map((a) => (
                      <li key={a.id}>
                        ${money(a.amountCents)}/month from {fmtDate(a.startDate)} · {AUTH_METHODS[a.method as keyof typeof AUTH_METHODS]} · authorized by {a.authorizedByName} on {fmtDate(a.authorizedAt)}
                        {a.revokedAt ? <Badge tone="gray" className="ml-1">Ended {fmtDate(a.revokedAt)}</Badge> : <Badge tone="green" className="ml-1">Active</Badge>}
                        {!a.revokedAt && (
                          <ActionForm action={revokeAuthorizationAction.bind(null, clientId, a.id)} className="mt-1 flex flex-wrap items-end gap-2">
                            <input className="input w-64" name="reason" placeholder="Why is it ending?" aria-label="Reason" />
                            <Button type="submit" variant="ghost">End authorization</Button>
                          </ActionForm>
                        )}
                      </li>
                    ))}
                    {billing.authorizations.length === 0 && <li className="text-slate-600">None recorded.</li>}
                  </ul>
                  {billing.squareBilling.state !== "NONE" ? (
                    <p className="text-sm text-slate-600" data-testid="no-new-authorization">Billed through Square: the existing authorization stays in place, so no new one is recorded here and nothing is charged from Client Connect.</p>
                  ) : (
                  <details>
                    <summary className="cursor-pointer text-sm underline">Record an authorization</summary>
                    <ActionForm action={recordAuthorizationAction.bind(null, clientId)} className="mt-2 grid gap-3 sm:grid-cols-3" resetOnSuccess>
                      <Field label="Authorized amount per month ($)"><input className="input" name="amount" inputMode="decimal" /></Field>
                      <Field label="First charge date"><input className="input" type="date" name="startDate" /></Field>
                      <Field label="How it was authorized"><select className="input" name="method" defaultValue=""><option value="">Choose…</option>{Object.entries(AUTH_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                      <Field label="Authorized by (name)"><input className="input" name="authorizedByName" /></Field>
                      <Field label="Date authorized"><input className="input" type="date" name="authorizedAt" /></Field>
                      <Field label="Signed form / agreement" hint="Upload it to the client's documents first">
                        <select className="input" name="evidenceDocumentId" defaultValue=""><option value="">—</option>{evidenceDocs.map((d) => <option key={d.id} value={d.id}>{d.title} · {fmtDate(d.createdAt)}</option>)}</select>
                      </Field>
                      <div className="sm:col-span-3"><Button type="submit" variant="secondary">Record authorization</Button></div>
                    </ActionForm>
                  </details>
                  )}
                </div>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function AccountForm({ clientId, account }: { clientId: string; account: { id: string; institution: string; accountType: string; last4: string | null; nickname: string | null; loginUrl: string | null; accessStatus: string; accessNote: string | null; active: boolean } | null }) {
  return (
    <ActionForm action={saveAccountAction.bind(null, clientId, account?.id ?? null)} className="mt-2 grid gap-3 sm:grid-cols-4" resetOnSuccess={!account}>
      <Field label="Bank or card company"><input className="input" name="institution" defaultValue={account?.institution ?? ""} /></Field>
      <Field label="Account type"><select className="input" name="accountType" defaultValue={account?.accountType ?? ""}><option value="">Choose…</option>{Object.entries(ACCOUNT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="Last 4 digits"><input className="input" name="last4" inputMode="numeric" maxLength={4} autoComplete="off" defaultValue={account?.last4 ?? ""} /></Field>
      <Field label="Nickname (optional)"><input className="input" name="nickname" defaultValue={account?.nickname ?? ""} /></Field>
      <Field label="Official sign-in page" hint="https:// address from the bank's website" className="sm:col-span-2"><input className="input" type="url" name="loginUrl" placeholder="https://" defaultValue={account?.loginUrl ?? ""} /></Field>
      <Field label="Access status"><select className="input" name="accessStatus" defaultValue={account?.accessStatus ?? "NOT_REQUESTED"}>{Object.entries(ACCESS_STATUSES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
      <Field label="Status"><select className="input" name="active" defaultValue={String(account?.active ?? true)}><option value="true">Open</option><option value="false">Closed</option></select></Field>
      <Field label="Access note (no passwords or codes)" className="sm:col-span-3"><input className="input" name="accessNote" placeholder="e.g. Client added us as accountant user 10/12" defaultValue={account?.accessNote ?? ""} /></Field>
      <div className="flex items-end"><Button type="submit" variant="secondary">{account ? "Save account" : "Add account"}</Button></div>
    </ActionForm>
  );
}
