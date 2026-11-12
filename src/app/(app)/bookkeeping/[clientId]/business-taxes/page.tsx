import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, PageHeader } from "@/components/ui";
import { addLicenseAction, removeLicenseAction, renewLicenseAction } from "@/app/actions/business-overview";
import { addBusinessTaxAction, addSuggestedTaxesAction, recordTaxFilingAction, removeBusinessTaxAction, undoTaxFilingAction, updateBusinessTaxAction } from "@/app/actions/business-taxes";
import { businessTaxesView, FREQUENCIES } from "@/lib/services/business-taxes";

export const metadata = { title: "Business Taxes & Licenses" };

const fmt = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ENTITY: Record<string, string> = { SOLE_PROPRIETOR: "Sole proprietor / single-member LLC", PARTNERSHIP: "Partnership / multi-member LLC", S_CORP: "S corporation", C_CORP: "C corporation", NONPROFIT: "Nonprofit", TRUST_ESTATE: "Trust or estate" };
const GROUPS = ["Sales & excise", "Licenses", "Annual business filings", "Payroll", "Property", "Other"];
const due = (r: { frequency: string; dueDay: number; dueMonth: number | null }) => {
  const day = r.dueDay >= 31 ? "last day" : `${r.dueDay}${[, "st", "nd", "rd"][r.dueDay % 10 > 3 || Math.floor(r.dueDay / 10) === 1 ? 0 : r.dueDay % 10] ?? "th"}`;
  return r.frequency === "ANNUAL" ? `${MONTHS[(r.dueMonth ?? 12) - 1]} ${r.dueDay >= 31 ? "(last day)" : r.dueDay}` : r.frequency === "MONTHLY" ? `${day} of the next month` : `${day} of the month after the period`;
};

function ScheduleFields({ frequency, dueDay, dueMonth }: { frequency?: string; dueDay?: number; dueMonth?: number | null }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <Field label="How often">
        <select name="frequency" className="input" defaultValue={frequency ?? "MONTHLY"}>
          {Object.entries(FREQUENCIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <Field label="Due day (31 = last)"><input name="dueDay" type="number" min={1} max={31} className="input" defaultValue={dueDay ?? 20} /></Field>
      <Field label="Month (yearly)">
        <select name="dueMonth" className="input" defaultValue={dueMonth ?? ""}>
          <option value="">—</option>
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
      </Field>
    </div>
  );
}

export default async function BusinessTaxesPage({ params }: { params: Promise<{ clientId: string }> }) {
  await connection();
  const actor = await requireUser();
  const { clientId } = await params;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { displayName: true, businessName: true } });
  if (!client) notFound();
  const v = await businessTaxesView(actor, clientId);
  const name = client.businessName || client.displayName;
  const groups = GROUPS.map((g) => ({ g, rows: v.rows.filter((r) => r.group === g) })).filter((x) => x.rows.length);

  return (
    <>
      <PageHeader title="Business Taxes & Licenses" subtitle={`${name} — every tax, return and license this business files, when each is due, and what was filed and paid.`} />
      <div className="mb-4 grid gap-3 sm:grid-cols-3" data-testid="tax-totals">
        <div className="rounded-xl border border-ivory-200 bg-white p-4"><p className="text-xs uppercase tracking-wide text-slate-500">On the list</p><p className="text-2xl font-semibold text-navy-900">{v.totals.items}</p></div>
        <div className="rounded-xl border border-ivory-200 bg-white p-4"><p className="text-xs uppercase tracking-wide text-slate-500">Past due</p><p className={`text-2xl font-semibold ${v.totals.overdue ? "text-red-700" : "text-navy-900"}`}>{v.totals.overdue}</p></div>
        <div className="rounded-xl border border-ivory-200 bg-white p-4"><p className="text-xs uppercase tracking-wide text-slate-500">Due in the next 30 days</p><p className="text-2xl font-semibold text-navy-900">{v.totals.dueIn30}</p></div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {v.suggestions.length > 0 && (
            <Card title="Suggested for this business">
              <p className="mb-2 text-sm text-slate-600">
                From what we know: {[v.facts.entityType ? ENTITY[v.facts.entityType] ?? v.facts.entityType : "entity type not set", v.facts.payroll ? "runs payroll" : "no payroll", [v.facts.city, v.facts.state].filter(Boolean).join(", ") || "location not set"].join(" · ")}. Set these on the Business Profile for better suggestions.
              </p>
              <ActionForm action={addSuggestedTaxesAction.bind(null, clientId)} className="space-y-2">
                <ul className="space-y-1" data-testid="tax-suggestions">
                  {v.suggestions.map((s) => (
                    <li key={s.key}>
                      <label className="flex items-start gap-2 text-sm">
                        <input type="checkbox" name="kind" value={s.key} defaultChecked className="mt-1" />
                        <span><span className="font-semibold text-navy-900">{s.label}</span> <span className="text-slate-500">— {s.why}</span></span>
                      </label>
                    </li>
                  ))}
                </ul>
                <Button type="submit">Add checked items</Button>
              </ActionForm>
            </Card>
          )}

          <Card title="Taxes & filings">
            {groups.length ? (
              <div className="space-y-5" data-testid="tax-list">
                {groups.map(({ g, rows }) => (
                  <section key={g}>
                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gold-700">{g}</h3>
                    <ul className="divide-y divide-ivory-200">
                      {rows.map((r) => (
                        <li key={r.id} className="py-3">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="font-semibold text-navy-900">
                                {r.name}{" "}
                                {r.overdue.length > 0 ? <Badge tone="red">{r.overdue.length} past due</Badge> : r.nextInDays <= 14 ? <Badge tone="gold">Due soon</Badge> : <Badge tone="green">Current</Badge>}
                              </p>
                              <p className="text-sm text-slate-600">{[r.agency, r.accountNumber && `Acct ${r.accountNumber}`, `${r.frequencyLabel}, due ${due(r)}`].filter(Boolean).join(" · ")}</p>
                              <p className="text-sm text-slate-700">Next: <strong>{r.next.label}</strong> due {fmt(r.next.dueDate)}{r.paidThisYear > 0 && <> · Paid this year {usd(r.paidThisYear)}</>}</p>
                              {r.overdue.length > 0 && <p className="text-sm text-red-700">Past due: {r.overdue.map((p) => `${p.label} (${fmt(p.dueDate)})`).join(", ")}</p>}
                              {r.note && <p className="text-sm text-slate-500">{r.note}</p>}
                            </div>
                          </div>
                          <ActionForm action={recordTaxFilingAction.bind(null, r.id)} className="mt-2 flex flex-wrap items-end gap-2" resetOnSuccess>
                            <Field label="Period">
                              <select name="period" className="input" defaultValue={(r.overdue[0] ?? r.next).period}>
                                {[...r.overdue, r.next].map((p) => <option key={p.period} value={p.period}>{p.label} — due {fmt(p.dueDate)}</option>)}
                              </select>
                            </Field>
                            <Field label="Amount paid"><input name="amount" inputMode="decimal" className="input w-28" placeholder="0.00" /></Field>
                            <Field label="Confirmation #"><input name="confirmation" maxLength={80} className="input w-36" /></Field>
                            <Field label="Filed on"><input name="filedOn" type="date" className="input" /></Field>
                            <Field label="Status">
                              <select name="status" className="input"><option value="FILED">Filed</option><option value="NOT_REQUIRED">Not required</option></select>
                            </Field>
                            <Button type="submit" variant="secondary">Mark</Button>
                          </ActionForm>
                          <details className="mt-2 text-sm">
                            <summary className="cursor-pointer text-navy-700">History, edit or remove</summary>
                            {r.history.length ? (
                              <ul className="mt-2 space-y-1">
                                {r.history.map((h) => (
                                  <li key={h.id} className="flex flex-wrap items-center gap-2">
                                    <span>{h.period}: {h.status === "FILED" ? `filed${h.filedOn ? ` ${fmt(h.filedOn)}` : ""}${h.amountCents != null ? `, paid ${usd(h.amountCents)}` : ""}${h.confirmation ? `, conf. ${h.confirmation}` : ""}` : "not required"}</span>
                                    <ActionForm action={undoTaxFilingAction.bind(null, h.id)} confirm={`Undo ${h.period}?`}><Button type="submit" variant="ghost">Undo</Button></ActionForm>
                                  </li>
                                ))}
                              </ul>
                            ) : <p className="mt-2 text-slate-500">Nothing marked filed yet.</p>}
                            <ActionForm action={updateBusinessTaxAction.bind(null, r.id)} className="mt-3 space-y-2">
                              <div className="grid gap-2 sm:grid-cols-2">
                                <Field label="Name"><input name="name" className="input" defaultValue={r.name} maxLength={120} /></Field>
                                <Field label="Filed with"><input name="agency" className="input" defaultValue={r.agency ?? ""} maxLength={160} /></Field>
                                <Field label="Account number"><input name="accountNumber" className="input" defaultValue={r.accountNumber ?? ""} maxLength={60} /></Field>
                                <Field label="Track from"><input name="trackFrom" type="date" className="input" defaultValue={r.trackFrom} /></Field>
                              </div>
                              <ScheduleFields frequency={r.frequency} dueDay={r.dueDay} dueMonth={r.dueMonth} />
                              <Field label="Note"><input name="note" className="input" defaultValue={r.note ?? ""} maxLength={300} /></Field>
                              <Button type="submit" variant="secondary">Save changes</Button>
                            </ActionForm>
                            <ActionForm action={removeBusinessTaxAction.bind(null, r.id)} confirm={`Remove ${r.name}? Its history is kept.`} className="mt-2"><Button type="submit" variant="ghost">Remove from the list</Button></ActionForm>
                          </details>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-600">No taxes or filings added yet. Add the suggested ones or pick from the list on the right.</p>
            )}
          </Card>

          <Card title="Licenses & permits">
            <div id="licenses" />
            {v.licenses.length ? (
              <ul className="divide-y divide-ivory-200" data-testid="license-list">
                {v.licenses.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-end justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-navy-900">{l.name} {l.renewal && (l.expired ? <Badge tone="red">Expired</Badge> : <Badge tone="green">Current</Badge>)}</p>
                      <p className="text-sm text-slate-600">{[l.jurisdiction, l.licenseNumber && `No. ${l.licenseNumber}`, l.renewal ? `Renews ${fmt(l.renewal)}` : "No renewal date"].filter(Boolean).join(" · ")}</p>
                      {l.note && <p className="text-sm text-slate-500">{l.note}</p>}
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <ActionForm action={renewLicenseAction.bind(null, l.id)} className="flex items-end gap-2">
                        <Field label="New renewal date"><input type="date" name="renewalDate" required className="input" defaultValue={l.renewal ?? ""} /></Field>
                        <Button type="submit" variant="secondary">Save</Button>
                      </ActionForm>
                      <ActionForm action={removeLicenseAction.bind(null, l.id)} confirm={`Remove ${l.name}? It stays in the history.`}><Button type="submit" variant="ghost">Remove</Button></ActionForm>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-600">No licenses added yet.</p>
            )}
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-navy-700">Add a license by hand</summary>
              <ActionForm action={addLicenseAction.bind(null, clientId)} className="mt-2 space-y-2" resetOnSuccess>
                <Field label="License or permit"><input name="name" required maxLength={120} className="input" placeholder="e.g. City business license" /></Field>
                <Field label="Issued by (optional)"><input name="jurisdiction" maxLength={120} className="input" /></Field>
                <Field label="License number (optional)"><input name="licenseNumber" maxLength={60} className="input" /></Field>
                <Field label="Renewal date"><input type="date" name="renewalDate" className="input" /></Field>
                <Field label="Note (optional)"><input name="note" maxLength={300} className="input" /></Field>
                <Button type="submit">Add license</Button>
              </ActionForm>
            </details>
          </Card>
        </div>

        <Card title="Add a tax or filing">
          <ActionForm action={addBusinessTaxAction.bind(null, clientId)} className="space-y-3" resetOnSuccess>
            <Field label="Type">
              <select name="kind" className="input" defaultValue="OTHER">
                <option value="OTHER">Other (write it in)</option>
                {GROUPS.slice(0, 5).map((g) => (
                  <optgroup key={g} label={g}>
                    {v.catalog.filter((c) => c.group === g).map((c) => <option key={c.key} value={c.key}>{c.label}{c.added ? " (on the list)" : ""}</option>)}
                  </optgroup>
                ))}
              </select>
            </Field>
            <p className="text-xs text-slate-500">Pick a type and leave the rest blank to use its usual schedule (Alabama and federal). Fill in any field to change it.</p>
            <Field label="Name (optional for a listed type)"><input name="name" maxLength={120} className="input" placeholder="e.g. Jefferson County sales tax" /></Field>
            <Field label="Filed with (optional)"><input name="agency" maxLength={160} className="input" /></Field>
            <Field label="Account number (optional)"><input name="accountNumber" maxLength={60} className="input" /></Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="How often">
                <select name="frequency" className="input" defaultValue="">
                  <option value="">Usual</option>
                  {Object.entries(FREQUENCIES).map(([k, x]) => <option key={k} value={k}>{x}</option>)}
                </select>
              </Field>
              <Field label="Due day"><input name="dueDay" type="number" min={1} max={31} className="input" placeholder="Usual" /></Field>
              <Field label="Month (yearly)">
                <select name="dueMonth" className="input" defaultValue="">
                  <option value="">Usual</option>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Track from (optional)"><input name="trackFrom" type="date" className="input" /></Field>
            <p className="text-xs text-slate-500">Periods due before this date are never shown as past due. Leave blank to start today; set an earlier date to log past filings.</p>
            <Field label="Note (optional)"><input name="note" maxLength={300} className="input" /></Field>
            <Button type="submit">Add</Button>
          </ActionForm>
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-navy-700">What each type covers</summary>
            <ul className="mt-2 space-y-2">
              {v.catalog.map((c) => <li key={c.key}><strong className="text-navy-900">{c.label}</strong> — {c.agency}. {c.help}</li>)}
            </ul>
          </details>
        </Card>
      </div>
    </>
  );
}
