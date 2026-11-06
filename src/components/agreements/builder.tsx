"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { ActionForm } from "@/components/action-form";
import type { ActionState } from "@/lib/action";
import {
  AGREEMENT_METHODS, BILLING_FREQUENCIES, FEE_STRUCTURES, SERVICE_LABELS, TERMS, renderAgreement,
  type AgreementMethod, type AgreementOptions, type LibraryClause, type ServiceKey, type Toggles,
} from "@/lib/agreements/catalog";

export type BuilderTemplate = { key: string; name: string; description: string; title: string; intro: string; clauseKeys: string[]; version: number };

const TOGGLES: { key: keyof Toggles; label: string }[] = [
  { key: "latePayment", label: "Late-payment and collections clause" },
  { key: "nonCancellable", label: "Can't be cancelled after the work is delivered" },
  { key: "bundledService", label: "Bundled service: bookkeeping required for the tax return" },
  { key: "clientResponsibilities", label: "Client responsibilities" },
  { key: "confidentiality", label: "Confidentiality" },
  { key: "esign", label: "E-sign consent (“I agree to sign electronically.”) — required to send" },
];

function MoneyInput({ cents, onCents, label, className }: { cents: number | null; onCents: (c: number) => void; label: string; className?: string }) {
  const [text, setText] = useState(cents ? (cents / 100).toFixed(2) : "");
  return (
    <input
      className={clsx("input", className)}
      inputMode="decimal"
      placeholder="$0.00"
      aria-label={label}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value.replace(/[$,\s]/g, ""));
        onCents(Number.isFinite(n) ? Math.round(n * 100) : 0);
      }}
    />
  );
}

const box = "rounded-xl border border-navy-100 bg-white p-4";
const h = "mb-2 font-serif text-base font-bold text-navy-900";
const check = "flex min-h-11 items-center gap-2 text-sm";

/**
 * Steps (b) and (c) of New agreement: the template cards, the options and a live preview
 * of the agreement text. Drafts only — sending is a separate step on the agreement page.
 */
export function AgreementBuilder({
  action, templates, library, clientName, clientId, prefills, initialTemplate, initialOptions, initialTitle, lockTemplate = false, submitLabel = "Save draft",
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  templates: BuilderTemplate[];
  library: LibraryClause[];
  clientName: string;
  clientId: string;
  prefills: Record<string, AgreementOptions>;
  initialTemplate?: string;
  initialOptions?: AgreementOptions;
  initialTitle?: string;
  lockTemplate?: boolean;
  submitLabel?: string;
}) {
  const [tKey, setTKey] = useState(initialTemplate ?? "");
  const [o, setO] = useState<AgreementOptions | null>(initialOptions ?? (initialTemplate ? prefills[initialTemplate] : null));
  const [title, setTitle] = useState(initialTitle ?? templates.find((t) => t.key === initialTemplate)?.title ?? "");
  // Re-mounts the money inputs when a template is picked (fresh prefilled values).
  const [gen, setGen] = useState(0);
  const t = templates.find((x) => x.key === tKey);
  const set = <K extends keyof AgreementOptions>(k: K, v: AgreementOptions[K]) => setO((p) => (p ? { ...p, [k]: v } : p));
  const preview = useMemo(() => (t && o ? renderAgreement({ title: title || t.title, intro: t.intro, templateKey: t.key, templateClauseKeys: t.clauseKeys, options: o, clientName, library }) : null), [t, o, title, clientName, library]);

  const pick = (k: string) => {
    setTKey(k);
    setO(structuredClone(prefills[k]));
    setTitle(templates.find((x) => x.key === k)?.title ?? "");
    setGen((g) => g + 1);
  };

  return (
    <div className="space-y-6">
      {!lockTemplate && (
        <section aria-labelledby="step-b" data-testid="step-b">
          <h2 id="step-b" className="mb-3 font-serif text-xl font-bold text-navy-900">Step 2 · Choose the type</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {templates.map((x) => (
              <button
                key={x.key}
                type="button"
                onClick={() => pick(x.key)}
                aria-pressed={tKey === x.key}
                data-testid={`template-${x.key}`}
                className={clsx("min-h-24 rounded-xl border p-3 text-left text-sm transition", tKey === x.key ? "border-navy-900 bg-navy-900 text-white shadow-md" : "border-navy-100 bg-white text-navy-900 hover:border-navy-700")}
              >
                <span className="block font-semibold">{x.name}</span>
                <span className={clsx("mt-1 block text-xs", tKey === x.key ? "text-navy-100" : "text-slate-600")}>{x.description}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {t && o && preview && (
        <section aria-labelledby="step-c" data-testid="step-c">
          <h2 id="step-c" className="mb-3 font-serif text-xl font-bold text-navy-900">{lockTemplate ? "Options" : "Step 3 · Options"} <span className="text-sm font-normal text-slate-600">— {t.name}, template v{t.version}</span></h2>
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <ActionForm action={action} className="space-y-4" key={gen}>
              <input type="hidden" name="clientId" value={clientId} />
              <input type="hidden" name="templateKey" value={t.key} />
              <input type="hidden" name="options" value={JSON.stringify(o)} />
              <div className={box}>
                <label className="block text-sm font-semibold text-navy-900">Agreement title
                  <input className="input mt-1" name="title" value={title} onChange={(e) => setTitle(e.target.value)} required />
                </label>
              </div>

              <div className={box}>
                <p className={h}>Services included</p>
                <div className="grid gap-x-4 sm:grid-cols-2">
                  {(Object.keys(SERVICE_LABELS) as ServiceKey[]).map((s) => (
                    <label key={s} className={check}><input type="checkbox" className="size-5 accent-navy-900" checked={o.services.includes(s)} onChange={(e) => set("services", e.target.checked ? [...o.services, s] : o.services.filter((x) => x !== s))} /> {SERVICE_LABELS[s]}</label>
                  ))}
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <label className="text-sm">Tax year<input className="input mt-1" inputMode="numeric" value={o.taxYear ?? ""} onChange={(e) => set("taxYear", e.target.value ? Number(e.target.value) : null)} /></label>
                  <label className="text-sm">Service period (optional)<input className="input mt-1" placeholder="e.g. January–December 2026" value={o.periodLabel} onChange={(e) => set("periodLabel", e.target.value)} /></label>
                </div>
                <label className="mt-2 block text-sm">Notes on the services (shown in the agreement)<textarea className="input mt-1" rows={2} value={o.serviceNotes} onChange={(e) => set("serviceNotes", e.target.value)} /></label>
              </div>

              <div className={box}>
                <p className={h}>Fees</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-sm">Fee structure
                    <select className="input mt-1" value={o.feeStructure} onChange={(e) => set("feeStructure", e.target.value as AgreementOptions["feeStructure"])}>{Object.entries(FEE_STRUCTURES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                  </label>
                  <label className="text-sm">Billing frequency
                    <select className="input mt-1" value={o.billingFrequency} onChange={(e) => set("billingFrequency", e.target.value as AgreementOptions["billingFrequency"])}>{Object.entries(BILLING_FREQUENCIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                  </label>
                </div>
                <div className="mt-2 space-y-2" data-testid="fee-lines">
                  {o.fees.map((f, i) => (
                    <div key={i} className="flex gap-2">
                      <input className="input flex-1" aria-label={`Fee ${i + 1} description`} placeholder={o.feeStructure === "HOURLY" ? "Hourly rate" : "e.g. Monthly bookkeeping"} value={f.label} onChange={(e) => set("fees", o.fees.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                      <MoneyInput className="w-32" label={`Fee ${i + 1} amount`} cents={f.cents} onCents={(c) => set("fees", o.fees.map((x, j) => (j === i ? { ...x, cents: c } : x)))} />
                      <button type="button" className="min-h-11 rounded-lg px-2 text-sm text-red-800 underline" onClick={() => set("fees", o.fees.filter((_, j) => j !== i))}>Remove</button>
                    </div>
                  ))}
                  {o.fees.length < 8 && <button type="button" className="min-h-11 text-sm font-semibold text-navy-900 underline" onClick={() => set("fees", [...o.fees, { label: "", cents: 0 }])}>+ Add a fee</button>}
                </div>
                <label className="mt-2 block text-sm">Invoice number (used by the invoice acknowledgment)<input className="input mt-1" value={o.invoiceNumber} onChange={(e) => set("invoiceNumber", e.target.value)} placeholder="e.g. INV-2026-0042" /></label>
              </div>

              <div className={box}>
                <p className={h}>Payment schedule</p>
                <label className="block text-sm">Deposit due at signing<MoneyInput className="mt-1 w-40" label="Deposit" cents={o.depositCents} onCents={(c) => set("depositCents", c)} /></label>
                <div className="mt-2 space-y-2" data-testid="installments">
                  {o.installments.map((x, i) => (
                    <div key={i} className="flex flex-wrap gap-2">
                      <MoneyInput className="w-32" label={`Installment ${i + 1} amount`} cents={x.cents} onCents={(c) => set("installments", o.installments.map((y, j) => (j === i ? { ...y, cents: c } : y)))} />
                      <input type="date" className="input w-44" aria-label={`Installment ${i + 1} due date`} value={x.date} onChange={(e) => set("installments", o.installments.map((y, j) => (j === i ? { ...y, date: e.target.value } : y)))} />
                      <button type="button" className="min-h-11 px-2 text-sm text-red-800 underline" onClick={() => set("installments", o.installments.filter((_, j) => j !== i))}>Remove</button>
                    </div>
                  ))}
                  {o.installments.length < 12 && <button type="button" className="min-h-11 text-sm font-semibold text-navy-900 underline" onClick={() => set("installments", [...o.installments, { cents: 0, date: "" }])}>+ Add an installment</button>}
                </div>
              </div>

              <div className={box}>
                <p className={h}>Start, term and renewal</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-sm">Start date<input type="date" className="input mt-1" value={o.startDate} onChange={(e) => set("startDate", e.target.value)} /></label>
                  <label className="text-sm">Term<select className="input mt-1" value={o.term} onChange={(e) => set("term", e.target.value as AgreementOptions["term"])}>{Object.entries(TERMS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                </div>
                {o.term === "TWELVE_MONTHS" && (
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    <label className={check}><input type="checkbox" className="size-5 accent-navy-900" checked={o.autoRenew} onChange={(e) => set("autoRenew", e.target.checked)} /> Renews automatically</label>
                    {o.autoRenew && <label className="text-sm">Annual increase %<input className="input mt-1 w-24" inputMode="decimal" value={o.renewalIncreasePct} onChange={(e) => set("renewalIncreasePct", Number(e.target.value) || 0)} /></label>}
                  </div>
                )}
                <label className="mt-2 block text-sm">Termination notice (days)<input className="input mt-1 w-28" inputMode="numeric" value={o.terminationNoticeDays ?? ""} onChange={(e) => set("terminationNoticeDays", e.target.value ? Number(e.target.value) : null)} /></label>
              </div>

              <div className={box}>
                <p className={h}>Accepted payment methods</p>
                <div className="grid gap-x-4 sm:grid-cols-2">
                  {(Object.keys(AGREEMENT_METHODS) as AgreementMethod[]).map((m) => (
                    <label key={m} className={check}><input type="checkbox" className="size-5 accent-navy-900" checked={o.paymentMethods.includes(m)} onChange={(e) => set("paymentMethods", e.target.checked ? [...o.paymentMethods, m] : o.paymentMethods.filter((x) => x !== m))} /> {AGREEMENT_METHODS[m].replace(/^./, (c) => c.toUpperCase())}{m === "PAYMENT_LINK" ? " (card processing fee note)" : ""}</label>
                  ))}
                </div>
              </div>

              <div className={box}>
                <p className={h}>Clauses</p>
                {t.key === "CUSTOM" ? (
                  <div data-testid="custom-clauses">
                    {library.map((c) => (
                      <label key={c.key} className={check}><input type="checkbox" className="size-5 accent-navy-900" checked={o.customClauseKeys.includes(c.key)} onChange={(e) => set("customClauseKeys", e.target.checked ? [...o.customClauseKeys, c.key] : o.customClauseKeys.filter((x) => x !== c.key))} /> {c.title}{c.status !== "APPROVED" && <span className="text-xs font-semibold text-amber-800"> · DRAFT</span>}</label>
                    ))}
                  </div>
                ) : (
                  TOGGLES.map((x) => (
                    <label key={x.key} className={check}><input type="checkbox" className="size-5 accent-navy-900" checked={o.toggles[x.key]} onChange={(e) => set("toggles", { ...o.toggles, [x.key]: e.target.checked })} /> {x.label}</label>
                  ))
                )}
                {(o.toggles.bundledService || o.customClauseKeys.includes("bundled_bookkeeping")) && (
                  <div className="mt-2 grid gap-2 rounded-lg bg-ivory-50 p-2 sm:grid-cols-2">
                    <label className="text-sm">Bookkeeping per month<MoneyInput className="mt-1" label="Bookkeeping per month" cents={o.bundledMonthlyCents} onCents={(c) => set("bundledMonthlyCents", c || null)} /></label>
                    <label className="text-sm">Bookkeeping period<input className="input mt-1" placeholder="e.g. January–December 2026" value={o.bundledPeriod} onChange={(e) => set("bundledPeriod", e.target.value)} /></label>
                  </div>
                )}
              </div>

              <div className={box}>
                <p className={h}>Questions for the client</p>
                <label className={check}><input type="checkbox" className="size-5 accent-navy-900" checked={o.askServiceSelection} onChange={(e) => set("askServiceSelection", e.target.checked)} /> “Do you want to begin … now?”</label>
                {o.askServiceSelection && <label className="block text-sm">What to begin<input className="input mt-1" placeholder="e.g. the 2026 bookkeeping" value={o.serviceQuestion} onChange={(e) => set("serviceQuestion", e.target.value)} /></label>}
                <label className={check}><input type="checkbox" className="size-5 accent-navy-900" checked={o.askPaymentMethod} onChange={(e) => set("askPaymentMethod", e.target.checked)} /> “How do you plan to make your payments?”</label>
              </div>

              <button type="submit" className="min-h-11 w-full rounded-xl bg-navy-900 px-4 py-3 font-semibold text-white hover:bg-navy-800" data-testid="save-agreement">{submitLabel}</button>
              <p className="text-xs text-slate-600">Saving makes a draft. Nothing is sent to the client from here.</p>
            </ActionForm>

            <aside className="lg:sticky lg:top-4" aria-label="Preview" data-testid="agreement-preview">
              <div className="rounded-2xl border border-gold-300 bg-ivory-50 p-5 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-700">Live preview</p>
                <h3 className="mt-1 font-serif text-xl font-bold text-navy-900">{preview.title}</h3>
                <p className="mt-2 text-sm text-slate-800">{preview.intro}</p>
                <ol className="mt-3 space-y-3 text-sm">
                  {preview.clauses.map((c, i) => (
                    <li key={c.key} className="text-slate-900">
                      <p className="font-semibold text-navy-900">
                        {i + 1}. {c.kind === "ACK" && <span aria-hidden>☐ </span>}{c.title}
                        {c.status !== "APPROVED" && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-900" data-testid="draft-badge">DRAFT — needs Tabitha&apos;s approval</span>}
                      </p>
                      <p className="whitespace-pre-wrap">{c.text}</p>
                    </li>
                  ))}
                </ol>
                {preview.questions.map((q) => (
                  <p key={q.key} className="mt-3 text-sm"><strong>{q.text}</strong> {q.choices.join(" / ")}</p>
                ))}
                <p className="mt-3 text-xs text-slate-700">Then: Full Legal Name, Address, Phone, Email, Client Signature, Date Signed.</p>
              </div>
              {(preview.missing.length > 0 || preview.drafts.length > 0) && (
                <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="preview-blockers">
                  {preview.missing.length > 0 && <p>Still to fill in: {preview.missing.map((m) => m.replace(/_/g, " ").toLowerCase()).join(", ")}.</p>}
                  {preview.drafts.length > 0 && <p>DRAFT clauses (can&apos;t be sent until Tabitha approves): {preview.drafts.join(", ")}.</p>}
                </div>
              )}
            </aside>
          </div>
        </section>
      )}
    </div>
  );
}
