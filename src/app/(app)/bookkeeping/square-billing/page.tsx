import Link from "next/link";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { SquareStateBadge } from "@/components/square-billing-panel";
import { linkSquareBillingAction, syncAllSquareBillingAction } from "@/app/actions/square-billing";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { squareSettings, SquareError } from "@/lib/square";
import { ForbiddenError } from "@/lib/auth/actor";
import { ValidationError } from "@/lib/services/clients";
import { canManageBilling } from "@/lib/services/bookkeeping-profile";
import { businessFamily } from "@/lib/services/related-businesses";
import { CADENCE_LABELS, INVOICE_STATUS_LABELS, nameOf, lookupSquareBilling, paymentStatus, scheduleText, squareBillingOverview } from "@/lib/services/square-billing";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Square billing" };

type SP = { client?: string; email?: string; phone?: string; customer?: string };
const usd = (c: number | null | undefined) => (c == null ? "—" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);

export default async function SquareBillingPage({ searchParams }: { searchParams: Promise<SP> }) {
  await connection();
  const user = await requireUser();
  if (!(await canManageBilling(user))) {
    return (
      <>
        <PageHeader title="Square billing" />
        <Notice>Billing is managed by Tabitha.</Notice>
      </>
    );
  }
  const sp = await searchParams;
  const rows = await squareBillingOverview(user);
  const configured = squareSettings().configured;
  const chosen = sp.client ? await prisma.client.findUnique({ where: { id: sp.client }, select: { id: true, displayName: true, businessName: true, email: true, phone: true, contacts: { select: { email: true, phone: true }, take: 3 } } }) : null;
  const family = chosen ? await businessFamily(chosen.id) : null;
  const coverOptions = chosen ? [chosen, ...(family ? [family.person, ...family.businesses] : [])].filter((c, i, all): c is NonNullable<typeof c> => !!c && all.findIndex((x) => x?.id === c.id) === i) : [];
  const email = sp.email ?? chosen?.email ?? chosen?.contacts.find((c) => c.email)?.email ?? "";
  const phone = sp.phone ?? chosen?.phone ?? chosen?.contacts.find((c) => c.phone)?.phone ?? "";
  const searched = !!(sp.email || sp.phone || sp.customer);
  let results: Awaited<ReturnType<typeof lookupSquareBilling>> = [];
  let lookupError: string | null = null;
  if (searched && configured) {
    try {
      results = await lookupSquareBilling(user, { email: sp.email, phone: sp.phone, customerId: sp.customer });
    } catch (err) {
      if (err instanceof SquareError || err instanceof ValidationError || err instanceof ForbiddenError) lookupError = err.message;
      else throw err;
    }
  }
  const counts = { linked: rows.filter((r) => r.arrangement).length, waiting: rows.filter((r) => r.state === "NOT_SYNCED").length };

  return (
    <>
      <p className="mb-2 text-sm"><Link className="underline" href="/bookkeeping">← Bookkeeping Clients</Link></p>
      <PageHeader
        title="Square billing"
        subtitle="Connects the recurring invoices already set up in Square. Read only: nothing is created, changed or charged in Square, and clients aren't asked to authorize again."
        actions={configured ? <ActionForm action={syncAllSquareBillingAction} showSuccess><Button type="submit" variant="secondary">Sync all from Square</Button></ActionForm> : null}
      />
      {!configured && <Notice tone="warn" title="Square isn't connected yet">Add SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID and SQUARE_APPLICATION_ID in Netlify (never in GitHub or chat). Until then every client shows &ldquo;Existing Square billing—not yet synced&rdquo; and billing continues in Square as usual.</Notice>}

      <Card title="Find a client's billing in Square">
        <form className="grid gap-3 sm:grid-cols-5" method="get" data-testid="square-lookup">
          <Field label="Client in Client Connect">
            <select className="input" name="client" defaultValue={chosen?.id ?? ""}>
              <option value="">Choose…</option>
              {rows.map((r) => <option key={r.clientId} value={r.clientId}>{r.name}</option>)}
            </select>
          </Field>
          <Field label="Email in Square"><input className="input" name="email" type="email" defaultValue={email} /></Field>
          <Field label="Phone in Square"><input className="input" name="phone" type="tel" defaultValue={phone} /></Field>
          <Field label="or Square customer ID"><input className="input" name="customer" autoComplete="off" defaultValue={sp.customer ?? ""} /></Field>
          <div className="flex items-end"><Button type="submit">Look up (read only)</Button></div>
        </form>
        <p className="mt-2 text-xs text-slate-600">Choose the client, then look them up. Their email and phone are filled in when we have them — change them if Square has different ones.</p>
        {lookupError && <p className="mt-3 text-sm text-red-700" role="alert">{lookupError}</p>}
        {searched && configured && !lookupError && results.length === 0 && <p className="mt-3 text-sm">No Square customer matched. Try another email, phone or the customer ID from the Square Dashboard.</p>}
        <div className="mt-3 space-y-3" data-testid="square-results">
          {results.map((c) => (
            <div key={c.id} className="rounded-xl border border-ivory-200 p-3">
              <p className="text-sm"><strong>{c.company || c.name || "Square customer"}</strong>{c.company && c.name ? ` · ${c.name}` : ""}{c.email ? ` · ${c.email}` : ""}{c.phone ? ` · ${c.phone}` : ""} <span className="text-xs text-slate-500">({c.id})</span></p>
              {c.series.length === 0 && <p className="mt-1 text-sm text-slate-600">No recurring invoices found for this customer.</p>}
              <ul className="mt-2 space-y-3">
                {c.series.map((s) => (
                  <li key={s.seriesKey} className="rounded-lg bg-ivory-50 p-3 text-sm" data-testid="square-series">
                    <p>
                      <strong>{s.title || "Recurring invoice"}</strong> · series {s.seriesKey}-R · {usd(s.amountCents)} · {scheduleText(s)}
                      {" · "}{s.nextDueDate ? `next ${fmtDate(s.nextDueDate)}` : "no upcoming invoice"}
                      {" · "}{s.autopay ? "charged automatically to the card on file in Square" : "client pays each invoice"}
                      {" · "}<Badge tone={paymentStatus(s).tone}>{paymentStatus(s).label}</Badge>
                    </p>
                    {s.linked ? (
                      <p className="mt-1">Already linked to: {s.linked.members.map((m, i) => <span key={m.clientId}>{i > 0 && ", "}<Link className="underline" href={`/bookkeeping/${m.clientId}/profile`}>{nameOf(m.client)}</Link></span>)}. Add other businesses from that profile&apos;s billing card.</p>
                    ) : !chosen ? (
                      <p className="mt-1 text-slate-600">Choose the client above to link this series.</p>
                    ) : (
                      <ActionForm action={linkSquareBillingAction.bind(null, c.id, s.seriesKey)} className="mt-2 space-y-2" showSuccess>
                        <fieldset>
                          <legend className="mb-1 font-semibold">This one bill covers</legend>
                          {coverOptions.map((o) => (
                            <label key={o.id} className="mr-4 inline-flex items-center gap-2"><input type="checkbox" name="clientIds" value={o.id} defaultChecked={o.id === chosen.id} /> {nameOf(o)}</label>
                          ))}
                        </fieldset>
                        <p className="text-xs text-slate-600">Check every business this Square bill pays for. Each business can be on only one Square bill, so none is charged twice. Amount, schedule and card stay exactly as they are in Square.</p>
                        <Button type="submit" variant="secondary">Link this Square billing</Button>
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>

      <Card title={`Bookkeeping clients · ${counts.linked} linked · ${counts.waiting} not yet synced`} className="mt-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="square-overview">
            <thead className="text-left text-slate-600"><tr><th className="py-1">Client</th><th>Square billing</th><th>Amount</th><th>Schedule</th><th>Next invoice</th><th>Payment status</th><th>One bill with</th></tr></thead>
            <tbody className="divide-y divide-navy-100">
              {rows.map((r) => {
                const a = r.arrangement;
                return (
                  <tr key={r.clientId}>
                    <td className="py-2"><Link className="underline" href={`/bookkeeping/${r.clientId}/profile`}>{r.name}</Link></td>
                    <td><SquareStateBadge state={r.state} /></td>
                    <td>{a?.syncedAt ? usd(a.amountCents) : "—"}</td>
                    <td>{a?.syncedAt ? CADENCE_LABELS[(a.cadence ?? "UNKNOWN") as keyof typeof CADENCE_LABELS] : "—"}</td>
                    <td>{a?.nextDueDate ? fmtDate(a.nextDueDate) : "—"}</td>
                    <td>{a?.syncedAt ? (a.lastInvoiceStatus ? INVOICE_STATUS_LABELS[a.lastInvoiceStatus] ?? a.lastInvoiceStatus : "—") : "—"}</td>
                    <td>{a && a.members.length > 1 ? a.members.filter((m) => m.clientId !== r.clientId).map((m) => nameOf(m.client)).join(", ") : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
