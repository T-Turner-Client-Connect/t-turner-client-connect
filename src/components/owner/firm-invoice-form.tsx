"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Check, FileText, LockKeyhole, Repeat, Search, UserRound, X } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { FirmInvoiceDocument } from "@/components/billing/firm-invoice-document";
import {
  clientPaymentOptions,
  FIRM_METHOD_INFO,
  FIRM_METHODS,
  FIRM_SERVICES,
  isSquarePaymentUrl,
  squarePayUrl,
  shortId,
  TAX_RETURN_SERVICES,
  type FirmMethod,
} from "@/lib/billing/invoice-status";

export type ClientChoice = { id: string; name: string; person: string | null; email: string | null; phone: string | null; address: string | null; type: string; squareCustomerId?: string | null };

/** Payment type (Create Invoice): one-time, or a billing schedule Tabitha approves. */
export type ScheduleOptions = {
  // false when editing an invoice that's already part of a schedule
  allowed: boolean;
  isOwner: boolean;
  // Double-billing warnings by client id (Square bookkeeping subscription, not-in-Square tracker, other schedules).
  warnings: Record<string, { text: string; service: string | null }[]>;
  // Creating (true) or editing an existing draft (false: the draft becomes the first cycle).
  creating: boolean;
};

const PAYMENT_TYPES = [
  ["ONE_TIME", "One-time invoice"],
  ["RECURRING", "Make this recurring"],
  ["DEPOSIT", "Deposit (balance invoiced later)"],
  ["INSTALLMENTS", "Installment plan"],
] as const;

const splitFirst = (total: number, n: number) => (n >= 2 ? Math.floor(total / n) : 0);
export type FirmInvoiceDefaults = {
  clientId: string;
  service: string;
  amount: string;
  description: string;
  issueDate: string;
  dueDate: string;
  privateNote: string;
  methods: string[];
  squarePaymentUrl: string;
};

const label = "mb-1 block text-sm font-semibold text-navy-900";
const toCents = (v: string) => {
  const s = v.replace(/[$,\s]/g, "");
  return /^\d+(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : 0;
};

/**
 * Admin Billing → Create Invoice. Pick an existing client (their name, billing contact and client
 * ID fill in from the master record), the service, amount and dates, and which approved payment
 * options to offer. The right side is a live preview of exactly what the client will see.
 */
export function FirmInvoiceForm({
  action,
  clients,
  defaults,
  number,
  approved,
  squareLive,
  squareSending,
  refundFeeNote,
  canApprove,
  schedule,
  origin,
}: {
  action: (prev: { error?: string; ok?: string } | null, fd: FormData) => Promise<{ error?: string; ok?: string } | null>;
  clients: ClientChoice[];
  defaults: FirmInvoiceDefaults;
  // The assigned number when editing; otherwise the next number (assigned for certain on save).
  number: { value: string; assigned: boolean };
  approved: { method: string; details: string }[];
  // Manual (pasted) Square links are on and Square is configured.
  squareLive: boolean;
  // "Send invoices through Square" is on and Square is configured: Square creates the link.
  squareSending: boolean;
  refundFeeNote: string | null;
  canApprove: boolean;
  schedule?: ScheduleOptions;
  // Made from a client's "Pay with an Invoice" request.
  origin?: { requestId: string | null; conversationId: string | null; title: string; alreadyInvoiced: string[] } | null;
}) {
  const [f, setF] = useState(defaults);
  const [type, setType] = useState<string>("ONE_TIME");
  const [p, setP] = useState({ planTotal: "", installments: "3", cadence: "MONTHLY", startDate: defaults.issueDate, endMode: "never", endDate: "", maxInvoices: "", invoiceDay: String(Math.min(28, Number(defaults.issueDate.slice(8, 10)) || 1)), dueInDays: "14", balanceDate: "" });
  const setPlan = (k: keyof typeof p, v: string) => setP((x) => ({ ...x, [k]: v }));
  const [linkOpen] = useState(() => !!defaults.squarePaymentUrl);
  const set = <K extends keyof FirmInvoiceDefaults>(k: K, v: FirmInvoiceDefaults[K]) => setF((x) => ({ ...x, [k]: v }));
  const [query, setQuery] = useState("");
  const client = clients.find((c) => c.id === f.clientId) ?? null;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return clients.filter((c) => [c.name, c.person, c.email, c.phone, c.id].some((v) => v?.toLowerCase().includes(q))).slice(0, 8);
  }, [clients, query]);

  const isApproved = (m: FirmMethod) => approved.some((a) => a.method === m);
  const rtAllowed = TAX_RETURN_SERVICES.includes(f.service);
  const methods = f.methods.filter((m) => isApproved(m as FirmMethod) && (m !== "REFUND_TRANSFER" || rtAllowed));
  const toggle = (m: string, on: boolean) => set("methods", on ? [...new Set([...f.methods, m])] : f.methods.filter((x) => x !== m));
  const urlProblem = f.squarePaymentUrl.trim() && !isSquarePaymentUrl(f.squarePaymentUrl.trim());
  const installments = Number(p.installments) || 0;
  const firstInstallment = splitFirst(toCents(p.planTotal), installments);
  const amountCents = type === "INSTALLMENTS" ? firstInstallment : toCents(f.amount);
  const planned = schedule?.allowed && type !== "ONE_TIME";
  const creatingSchedule = planned && schedule?.creating;
  const warnings = schedule && f.clientId ? (schedule.warnings[f.clientId] ?? []) : [];
  const sameService = warnings.filter((w) => !w.service || w.service === f.service);

  return (
    <ActionForm action={action} className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-5" data-testid="create-invoice-form">
        {origin && (
          <div className="rounded-xl border border-gold-300 bg-gold-50/70 px-4 py-3 text-sm text-navy-900" data-testid="request-origin">
            <input type="hidden" name="requestId" value={origin.requestId ?? ""} />
            <input type="hidden" name="conversationId" value={origin.conversationId ?? ""} />
            <p className="font-semibold">{origin.title}</p>
            <p className="mt-0.5 text-xs text-slate-700">Filled in from the request. Check the amount and description; nothing is sent until you send it the normal way.</p>
            {origin.alreadyInvoiced.length > 0 && <p className="mt-1 text-xs text-amber-900">They also asked about {origin.alreadyInvoiced.join(", ")} — that&apos;s already invoiced, so it isn&apos;t added here.</p>}
          </div>
        )}
        {/* 1. Client */}
        <section className="rounded-2xl border border-gold-200/80 bg-gradient-to-b from-white to-ivory-50 p-5 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)]">
          <h2 className="flex items-center gap-2 font-serif text-xl font-bold text-navy-900"><UserRound className="size-6 text-gold-600" aria-hidden /> Client</h2>
          <input type="hidden" name="clientId" value={f.clientId} />
          {client ? (
            <div className="mt-3 rounded-xl border border-gold-300 bg-white p-4" data-testid="selected-client">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-serif text-lg font-bold text-navy-900">{client.name}</p>
                  {client.person && <p className="text-sm text-slate-600">{client.person}</p>}
                </div>
                <button type="button" className="inline-flex items-center gap-1 text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4" onClick={() => set("clientId", "")}>
                  <X className="size-4" aria-hidden /> Change client
                </button>
              </div>
              <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <div><dt className="text-xs font-semibold uppercase tracking-wider text-gold-700">Client ID</dt><dd className="font-mono text-navy-900" title={client.id}>{client.id}</dd></div>
                <div><dt className="text-xs font-semibold uppercase tracking-wider text-gold-700">Billing email</dt><dd className="break-all text-navy-900">{client.email ?? <span className="text-slate-500">Not on file</span>}</dd></div>
                <div><dt className="text-xs font-semibold uppercase tracking-wider text-gold-700">Billing phone</dt><dd className="text-navy-900">{client.phone ?? <span className="text-slate-500">Not on file</span>}</dd></div>
                <div><dt className="text-xs font-semibold uppercase tracking-wider text-gold-700">Billing address</dt><dd className="whitespace-pre-line text-navy-900">{client.address ?? <span className="text-slate-500">Not on file</span>}</dd></div>
                <div className="sm:col-span-2"><dt className="text-xs font-semibold uppercase tracking-wider text-gold-700">Square customer</dt><dd className="font-mono text-navy-900" data-testid="square-customer">{client.squareCustomerId ?? <span className="font-sans text-slate-500">Not linked yet — matched by email or phone when sent through Square (never a duplicate)</span>}</dd></div>
              </dl>
              <p className="mt-3 text-xs text-slate-600">Filled in from the client&apos;s master record. To change these details, update the client&apos;s profile.</p>
            </div>
          ) : (
            <div className="mt-3">
              <label className={label} htmlFor="client-search">Select client</label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden />
                <input id="client-search" className="input pl-9" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, email, phone or client ID" autoComplete="off" data-testid="client-search" />
              </div>
              {query.trim() && (
                <ul className="mt-2 divide-y divide-ivory-200 overflow-hidden rounded-xl border border-ivory-200 bg-white" role="listbox" aria-label="Matching clients">
                  {matches.length === 0 ? (
                    <li className="px-4 py-3 text-sm text-slate-600">No client matches. Invoices are only for clients already in the client list.</li>
                  ) : (
                    matches.map((c) => (
                      <li key={c.id}>
                        <button type="button" role="option" aria-selected={false} className="block w-full px-4 py-2.5 text-left hover:bg-gold-50" onClick={() => { set("clientId", c.id); setQuery(""); }} data-testid="client-option">
                          <span className="block font-semibold text-navy-900">{c.name}</span>
                          <span className="block text-xs text-slate-600">{[c.person, c.email, c.phone, `ID ${shortId(c.id)}`].filter(Boolean).join(" · ")}</span>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </div>
          )}
        </section>

        {/* 2. Invoice details */}
        <section className="rounded-2xl border border-gold-200/80 bg-gradient-to-b from-white to-ivory-50 p-5 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)]">
          <h2 className="flex items-center gap-2 font-serif text-xl font-bold text-navy-900"><FileText className="size-6 text-gold-600" aria-hidden /> Invoice details</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <span className={label}>Invoice number</span>
              <p className="input flex items-center bg-ivory-100 font-mono" data-testid="number-preview">{number.value}</p>
              <span className="mt-1 block text-xs text-slate-600">{number.assigned ? "Assigned automatically." : "Assigned automatically when you save — never reused."}</span>
            </div>
            <label className="block">
              <span className={label}>Service</span>
              <select className="input" name="service" value={f.service} onChange={(e) => set("service", e.target.value)}>
                {FIRM_SERVICES.map((s) => <option key={s}>{s}</option>)}
              </select>
            </label>
            {type === "INSTALLMENTS" && schedule?.creating ? (
              <div>
                <span className={label}>Each installment</span>
                <p className="input flex items-center bg-ivory-100" data-testid="amount">{firstInstallment ? `$${(firstInstallment / 100).toFixed(2)}` : "Enter the plan total below"}</p>
                <input type="hidden" name="amount" value={firstInstallment ? (firstInstallment / 100).toFixed(2) : ""} />
              </div>
            ) : (
              <label className="block">
                <span className={label}>{type === "DEPOSIT" ? "Deposit amount (this invoice)" : type === "RECURRING" ? "Amount of each invoice" : "Invoice amount"}</span>
                <span className="relative block">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">$</span>
                  <input className="input pl-7" name="amount" inputMode="decimal" required placeholder="0.00" value={f.amount} onChange={(e) => set("amount", e.target.value)} data-testid="amount" />
                </span>
              </label>
            )}
            {!creatingSchedule && (
              <>
                <label className="block">
                  <span className={label}>Invoice date</span>
                  <input className="input" type="date" name="issueDate" required value={f.issueDate} onChange={(e) => set("issueDate", e.target.value)} />
                </label>
                <label className="block">
                  <span className={label}>Due date</span>
                  <input className="input" type="date" name="dueDate" required min={f.issueDate} value={f.dueDate} onChange={(e) => set("dueDate", e.target.value)} data-testid="due-date" />
                </label>
              </>
            )}
            <label className="block sm:col-span-2">
              <span className={label}>Description (services provided)</span>
              <textarea className="input" name="description" rows={3} required maxLength={2000} value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="e.g. 2025 federal and Alabama individual income tax returns" />
            </label>
            <label className="block sm:col-span-2">
              <span className={label}><LockKeyhole className="mr-1 inline size-4 align-[-2px] text-gold-600" aria-hidden />Internal notes <span className="font-normal text-slate-600">(optional — authorized staff only, never shown to the client)</span></span>
              <textarea className="input bg-ivory-100" name="privateNote" rows={2} maxLength={2000} value={f.privateNote} onChange={(e) => set("privateNote", e.target.value)} />
            </label>
          </div>
        </section>

        {/* Payment type: one-time, or a schedule (recurring, deposit, installments) Tabitha approves. */}
        {schedule?.allowed && (
          <section className="rounded-2xl border border-gold-200/80 bg-gradient-to-b from-white to-ivory-50 p-5 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)]" data-testid="payment-type">
            <h2 className="flex items-center gap-2 font-serif text-xl font-bold text-navy-900"><Repeat className="size-6 text-gold-600" aria-hidden /> Payment type</h2>
            <p className="mt-1 text-sm text-slate-600">For tax preparation and other individually billed work. Separate from bookkeeping subscriptions in Square, which aren&apos;t changed.</p>
            <input type="hidden" name="paymentType" value={type} />
            <div className="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Payment type">
              {PAYMENT_TYPES.filter(([k]) => schedule.creating || k === "ONE_TIME" || k === "RECURRING").map(([k, l]) => (
                <label key={k} className="flex cursor-pointer items-center gap-2 rounded-xl border border-gold-300 bg-white px-3 py-2.5 text-sm font-semibold text-navy-900 has-[:checked]:border-gold-500 has-[:checked]:bg-gold-50">
                  <input type="radio" name="paymentTypeChoice" value={k} checked={type === k} onChange={() => setType(k)} className="accent-navy-900" data-testid={`type-${k}`} /> {l}
                </label>
              ))}
            </div>
            {warnings.length > 0 && (
              <div className="mt-3 space-y-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950" data-testid="double-billing-warning">
                <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="size-4" aria-hidden /> Check before billing</p>
                {warnings.map((w) => <p key={w.text} className="text-xs">{w.text}</p>)}
                {warnings.some((w) => w.service === "Bookkeeping") && f.service !== "Bookkeeping" && <p className="text-xs">This invoice is labeled <strong>{f.service}</strong> — tax/other billing, separate from the bookkeeping subscription.</p>}
                {planned && sameService.length > 0 && (
                  <label className="mt-1 flex items-center gap-2 text-xs font-semibold"><input type="checkbox" name="confirmDuplicate" className="accent-navy-900" /> Create anyway — this is separate billing</label>
                )}
              </div>
            )}
            {planned && (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {type !== "RECURRING" && (
                  <label className="block">
                    <span className={label}>Plan total</span>
                    <input className="input" name="planTotal" inputMode="decimal" required placeholder="0.00" value={p.planTotal} onChange={(e) => setPlan("planTotal", e.target.value)} data-testid="plan-total" />
                  </label>
                )}
                {type === "INSTALLMENTS" && (
                  <label className="block">
                    <span className={label}>Number of installments</span>
                    <input className="input" name="installments" type="number" min={2} max={36} required value={p.installments} onChange={(e) => setPlan("installments", e.target.value)} />
                  </label>
                )}
                {(type === "RECURRING" || type === "INSTALLMENTS") && (
                  <label className="block">
                    <span className={label}>{type === "RECURRING" ? "How often" : "Every"}</span>
                    <select className="input" name="cadence" value={p.cadence} onChange={(e) => setPlan("cadence", e.target.value)} data-testid="cadence">
                      <option value="MONTHLY">Monthly</option>
                      <option value="QUARTERLY">Quarterly</option>
                      <option value="YEARLY">Yearly</option>
                    </select>
                  </label>
                )}
                <label className="block">
                  <span className={label}>{type === "DEPOSIT" ? "Deposit invoice date" : "Start date"}</span>
                  <input className="input" type="date" name="startDate" required value={schedule.creating ? p.startDate : f.issueDate} readOnly={!schedule.creating} onChange={(e) => setPlan("startDate", e.target.value)} data-testid="start-date" />
                </label>
                {type === "RECURRING" && (
                  <>
                    <label className="block">
                      <span className={label}>Invoice day of the month</span>
                      <input className="input" type="number" name="invoiceDay" min={1} max={28} required value={p.invoiceDay} onChange={(e) => setPlan("invoiceDay", e.target.value)} />
                    </label>
                    <fieldset className="sm:col-span-2">
                      <legend className={label}>Ends</legend>
                      <div className="flex flex-wrap items-center gap-3 text-sm">
                        {[["never", "No end date"], ["date", "On a date"], ["count", "After a number of invoices"]].map(([k, l]) => (
                          <label key={k} className="flex items-center gap-1.5"><input type="radio" name="endMode" value={k} checked={p.endMode === k} onChange={() => setPlan("endMode", k)} className="accent-navy-900" /> {l}</label>
                        ))}
                        {p.endMode === "date" && <input className="input w-auto" type="date" name="endDate" min={p.startDate} value={p.endDate} onChange={(e) => setPlan("endDate", e.target.value)} aria-label="End date" />}
                        {p.endMode === "count" && <input className="input w-28" type="number" name="maxInvoices" min={1} max={360} value={p.maxInvoices} onChange={(e) => setPlan("maxInvoices", e.target.value)} aria-label="Number of invoices" />}
                      </div>
                    </fieldset>
                  </>
                )}
                {type === "DEPOSIT" && (
                  <label className="block">
                    <span className={label}>Balance invoice date <span className="font-normal text-slate-600">(optional)</span></span>
                    <input className="input" type="date" name="balanceDate" min={p.startDate} value={p.balanceDate} onChange={(e) => setPlan("balanceDate", e.target.value)} />
                    <span className="mt-1 block text-xs text-slate-600">Blank = staff make the balance invoice when the work is done.</span>
                  </label>
                )}
                <label className="block">
                  <span className={label}>Due in (days after each invoice)</span>
                  <input className="input" type="number" name="dueInDays" min={0} max={120} required value={p.dueInDays} onChange={(e) => setPlan("dueInDays", e.target.value)} />
                </label>
                {type === "DEPOSIT" && toCents(p.planTotal) > 0 && toCents(f.amount) > 0 && (
                  <p className="text-sm text-navy-900 sm:col-span-2">Balance invoice later: <strong>${(Math.max(0, toCents(p.planTotal) - toCents(f.amount)) / 100).toFixed(2)}</strong></p>
                )}
                {type === "INSTALLMENTS" && installments >= 2 && toCents(p.planTotal) > 0 && (
                  <p className="text-sm text-navy-900 sm:col-span-2">{installments} invoices of ${(firstInstallment / 100).toFixed(2)}{toCents(p.planTotal) - firstInstallment * installments ? ` (the last is $${((toCents(p.planTotal) - firstInstallment * (installments - 1)) / 100).toFixed(2)})` : ""}.</p>
                )}
                <label className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm sm:col-span-2 ${schedule.isOwner ? "border-gold-300 bg-white" : "border-ivory-200 bg-ivory-100 opacity-80"}`}>
                  <input type="checkbox" name="autoSend" disabled={!schedule.isOwner} className="mt-0.5 size-4 accent-navy-900" data-testid="auto-send" />
                  <span>
                    <span className="block font-semibold text-navy-900">Send automatically each cycle</span>
                    <span className="block text-xs text-slate-600">Off: each cycle is created as a draft for review. On: sent through the normal send path — never while live sending or Square sending is off. {schedule.isOwner ? "" : "Only Tabitha can turn this on."}</span>
                  </span>
                </label>
                <p className="rounded-xl bg-navy-50 px-3 py-2 text-xs text-navy-900 sm:col-span-2" data-testid="schedule-approval-note">
                  {schedule.isOwner ? "You're approving this schedule as you save it. Each cycle is one invoice; the cron never makes a second one for the same period." : "This goes to Tabitha as a proposal: “Awaiting Tabitha's approval”. Nothing is invoiced until she approves it."}
                </p>
              </div>
            )}
          </section>
        )}

        {/* 3. Payment options */}
        <section className="rounded-2xl border border-gold-200/80 bg-gradient-to-b from-white to-ivory-50 p-5 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)]" data-testid="payment-options">
          <h2 className="font-serif text-xl font-bold text-navy-900">Payment options on this invoice</h2>
          <p className="mt-1 text-sm text-slate-600">Only methods the owner approved for business use can be offered. No processing fee or surcharge is added.</p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {FIRM_METHODS.map((m) => {
              const ok = isApproved(m) && (m !== "REFUND_TRANSFER" || rtAllowed);
              const why = !isApproved(m) ? "Not approved yet — the owner turns this on in Billing settings." : m === "REFUND_TRANSFER" && !rtAllowed ? "Eligible tax returns only." : FIRM_METHOD_INFO[m].sub;
              return (
                <li key={m} className={m === "REFUND_TRANSFER" || m === "SQUARE_INVOICE" ? "sm:col-span-2" : ""}>
                  <label className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 ${ok ? "cursor-pointer border-gold-300 bg-white has-[:checked]:border-gold-500 has-[:checked]:bg-gold-50" : "border-ivory-200 bg-ivory-100 opacity-70"}`}>
                    <input type="checkbox" name="method" value={m} disabled={!ok} checked={ok && f.methods.includes(m)} onChange={(e) => toggle(m, e.target.checked)} className="mt-1 size-4 accent-navy-900" data-testid={`method-${m}`} />
                    <span className="min-w-0">
                      <span className="block font-semibold text-navy-900">{FIRM_METHOD_INFO[m].label}</span>
                      <span className="block text-xs text-slate-600">{why}</span>
                    </span>
                  </label>
                  {m === "SQUARE_INVOICE" && ok && f.methods.includes(m) && (
                    <div className="mt-2 rounded-xl border border-ivory-200 bg-white p-3 text-sm" data-testid="square-link-help">
                      <p className="text-navy-900">
                        {squareSending
                          ? "Square creates this invoice and its secure payment link automatically when the approved invoice is sent through Square. There's no link to paste."
                          : "Square sending is off — Tabitha turns it on in Billing settings. Once it's on, Square creates the payment link automatically when the invoice is sent."}
                      </p>
                      <details className="mt-2" open={linkOpen}>
                        <summary className="cursor-pointer text-xs font-semibold text-slate-700 underline">Fallback: attach a Square link made by hand</summary>
                        <label className="mt-2 block">
                          <span className={label}>Square payment link <span className="font-normal text-slate-600">(optional — from the firm&apos;s own Square account)</span></span>
                          <input className="input" name="squarePaymentUrl" inputMode="url" placeholder="https://square.link/u/…" value={f.squarePaymentUrl} onChange={(e) => set("squarePaymentUrl", e.target.value)} />
                        </label>
                        {urlProblem && <p className="mt-1 text-xs text-red-800">Use a secure Square link (https://square.link/… or squareup.com).</p>}
                        <p className="mt-1 text-xs text-slate-600">
                          {squareLive ? "Manual Square links are on: if this invoice isn't sent through Square, the client sees this link." : "Manual Square links are off, so a pasted link isn't shown to the client."}
                        </p>
                      </details>
                    </div>
                  )}
                  {m === "REFUND_TRANSFER" && ok && f.methods.includes(m) && (
                    <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      Shown to the client as an option subject to staff approval and Republic Bank&apos;s requirements. It does not guarantee payment, and Republic Bank&apos;s disclosures apply. {refundFeeNote ? "Confirmed fees from Billing settings are shown." : "No fee amounts are shown until the owner confirms them in Billing settings."}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {creatingSchedule ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" name="intent" value="draft" data-testid="save-schedule"><Check className="size-4" aria-hidden /> {schedule?.isOwner ? "Approve & save schedule" : "Propose to Tabitha"}</Button>
            <p className="text-xs text-slate-600">{schedule?.isOwner ? "Cycles are created as drafts for review unless you turned on automatic sending." : "Nothing is invoiced until Tabitha approves it."}</p>
          </div>
        ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" name="intent" value="draft" variant="secondary">Save draft</Button>
          {!canApprove && <Button type="submit" name="intent" value="submit" data-testid="submit-for-approval"><Check className="size-4" aria-hidden /> Submit for owner approval</Button>}
          {canApprove && <Button type="submit" name="intent" value="draft" data-testid="save-and-review"><Check className="size-4" aria-hidden /> Save &amp; review to send</Button>}
          <p className="text-xs text-slate-600">{canApprove ? "Nothing is sent until you approve it on the next screen." : "The owner approves every invoice before it's sent."}</p>
        </div>
        )}
      </div>

      {/* Live preview — exactly what the client will see once it's approved and sent. */}
      <aside className="min-w-0 xl:sticky xl:top-4" aria-label="Invoice preview" data-testid="invoice-preview">
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gold-700">Client preview</p>
        <FirmInvoiceDocument
          doc={{
            number: number.value,
            status: "SENT",
            issueDate: creatingSchedule ? p.startDate : f.issueDate,
            dueDate: creatingSchedule && p.startDate ? new Date(new Date(`${p.startDate}T00:00:00Z`).getTime() + (Number(p.dueInDays) || 0) * 86_400_000).toISOString().slice(0, 10) : f.dueDate,
            billTo: { name: client?.name ?? "Select a client", email: client?.email ?? null, phone: client?.phone ?? null, address: client?.address ?? null },
            service: f.service,
            description: f.description,
            amountCents,
            paidCents: 0,
            creditedCents: 0,
            balanceCents: amountCents,
            payments: [],
            // Preview only: with Square sending on, the real link is created by Square when sent.
            options: clientPaymentOptions(methods, approved, { squareUrl: squarePayUrl({ squarePaymentUrl: f.squarePaymentUrl.trim() || null }, squareLive) ?? (squareSending ? "https://squareup.com/pay-invoice/preview" : null), refundFeeNote }),
          }}
        />
      </aside>
    </ActionForm>
  );
}
