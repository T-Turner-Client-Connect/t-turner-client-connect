import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { createExpenseAction, deleteExpenseAction } from "@/app/actions/owner";
import { requireOwner } from "@/lib/auth/owner";
import { EXPENSE_CATEGORIES, listExpenses } from "@/lib/services/owner-expenses";
import { todayYmd, ymd } from "@/lib/services/owner-billing";
import { money } from "@/lib/billing/pricing";
import { METHOD_LABELS } from "@/lib/billing/labels";

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ year?: string; month?: string; category?: string }> }) {
  const { actor } = await requireOwner("full");
  const sp = await searchParams;
  const today = todayYmd();
  const year = Number(sp.year) || Number(today.slice(0, 4));
  const month = sp.month === "all" ? null : Number(sp.month) || Number(today.slice(5, 7));
  const category = sp.category && (EXPENSE_CATEGORIES as readonly string[]).includes(sp.category) ? sp.category : null;
  const rows = await listExpenses(actor, { year, month, category });
  const byCategory = new Map<string, number>();
  rows.forEach((r) => byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.amountCents));
  const exportHref = `/api/owner/export?type=expenses&year=${year}${month ? `&month=${month}` : ""}${category ? `&category=${encodeURIComponent(category)}` : ""}`;
  return (
    <>
      <PageHeader title="Business expenses" subtitle="Private to you. Receipts are kept in a separate owner-only store, never in client documents." />
      <div className="grid gap-4 lg:grid-cols-[2fr_3fr]">
        <Card title="Add an expense">
          <ActionForm action={createExpenseAction} className="grid gap-3" resetOnSuccess idempotent>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Date"><input className="input" type="date" name="spentOn" defaultValue={today} required /></Field>
              <Field label="Amount"><input className="input" name="amount" inputMode="decimal" placeholder="0.00" required /></Field>
            </div>
            <Field label="Paid to"><input className="input" name="vendor" required /></Field>
            <Field label="Category">
              <select className="input" name="category" required>{EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
            </Field>
            <Field label="Paid with"><select className="input" name="method"><option value="">—</option>{Object.entries(METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Note"><input className="input" name="note" /></Field>
            <Field label="Receipt (PDF, PNG or JPG, optional)"><input className="input" type="file" name="receipt" accept="application/pdf,image/png,image/jpeg" /></Field>
            <Button type="submit">Save expense</Button>
          </ActionForm>
        </Card>
        <Card
          title={`${month ? new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" }) : "All of"} ${year}`}
          actions={<Link className="text-sm underline" href={exportHref}>Export CSV</Link>}
        >
          <form method="get" className="mb-3 flex flex-wrap gap-2 text-sm">
            <input className="input w-24" name="year" defaultValue={year} aria-label="Year" />
            <select className="input w-36" name="month" defaultValue={month ?? "all"} aria-label="Month">
              <option value="all">Whole year</option>
              {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{new Date(Date.UTC(2000, i, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" })}</option>)}
            </select>
            <select className="input" name="category" defaultValue={category ?? ""} aria-label="Category"><option value="">All categories</option>{EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
            <button className="rounded-lg border border-navy-200 px-3 font-semibold">Filter</button>
          </form>
          <p className="mb-2 text-sm">Total: <strong>{money(rows.reduce((s, r) => s + r.amountCents, 0))}</strong></p>
          {byCategory.size > 0 && <p className="mb-3 text-xs text-slate-600">{[...byCategory].map(([c, v]) => `${c}: ${money(v)}`).join(" · ")}</p>}
          <ul className="divide-y divide-navy-100 text-sm">
            {rows.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{ymd(e.spentOn)} · <strong>{e.vendor}</strong> · {e.category}{e.note ? ` · ${e.note}` : ""}</span>
                <span className="flex items-center gap-2">
                  {e.receiptKey && <a className="underline" href={`/api/owner/receipts/${e.id}`}>Receipt</a>}
                  <strong>{money(e.amountCents)}</strong>
                  <ActionForm action={deleteExpenseAction.bind(null, e.id)} confirm="Remove this expense? It stays in your private history but no longer counts."><Button variant="ghost">Remove</Button></ActionForm>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
