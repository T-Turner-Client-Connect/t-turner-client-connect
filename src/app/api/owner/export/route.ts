import { ownerFromSession } from "@/lib/auth/owner";
import { invoiceRows, monthlySummary, receivables, todayYmd } from "@/lib/services/owner-billing";
import { listExpenses } from "@/lib/services/owner-expenses";
import { dollars, toCsv } from "@/lib/csv";
import { prisma } from "@/lib/prisma";

// Owner-only CSV exports. Anyone else gets the same 404 as a missing page.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const actor = await ownerFromSession("full");
  if (!actor) return new Response("Not found", { status: 404 });
  const year = Number(url.searchParams.get("year")) || Number(todayYmd().slice(0, 4));
  let csv: string;
  if (type === "invoices") {
    const rows = await invoiceRows(actor, { clientId: url.searchParams.get("client") || undefined });
    csv = toCsv(
      ["Number", "Client", "Title", "Status", "Option", "Invoiced on", "Total", "Collected", "Balance", "Overdue", "Next due", "Services"],
      rows.map((r) => [r.number, r.clientName, r.title, r.state, r.option ?? "", r.invoicedOn ?? "", dollars(r.totalCents), dollars(r.collectedCents), dollars(r.balanceCents), dollars(r.overdueCents), r.nextDue ?? "", r.services.join("; ")]),
    );
  } else if (type === "payments") {
    const rows = await prisma.payment.findMany({ where: { receivedOn: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } }, include: { invoice: { select: { number: true } }, client: { select: { displayName: true } } }, orderBy: { receivedOn: "asc" } });
    csv = toCsv(["Date", "Client", "Invoice", "Type", "Result", "Method", "Amount", "Source", "Reference"], rows.map((p) => [p.receivedOn.toISOString().slice(0, 10), p.client.displayName, p.invoice.number, p.kind, p.status, p.method, dollars(p.amountCents), p.source, p.reference ?? ""]));
  } else if (type === "expenses") {
    const month = Number(url.searchParams.get("month")) || null;
    const rows = await listExpenses(actor, { year, month, category: url.searchParams.get("category") });
    csv = toCsv(["Date", "Paid to", "Category", "Method", "Amount", "Note", "Receipt"], rows.map((e) => [e.spentOn.toISOString().slice(0, 10), e.vendor, e.category, e.method ?? "", dollars(e.amountCents), e.note ?? "", e.receiptKey ? "yes" : ""]));
  } else if (type === "summary") {
    const { months, total } = await monthlySummary(actor, year);
    csv = toCsv(
      ["Month", "Invoiced", "Collected", "Refunded", "Expenses", "Net cash"],
      [...months.map((m) => [`${year}-${String(m.month).padStart(2, "0")}`, dollars(m.invoicedCents), dollars(m.collectedCents), dollars(m.refundedCents), dollars(m.expensesCents), dollars(m.netCashCents)]), ["Total", dollars(total.invoicedCents), dollars(total.collectedCents), dollars(total.refundedCents), dollars(total.expensesCents), dollars(total.netCashCents)]],
    );
  } else if (type === "receivables") {
    const r = await receivables(actor);
    csv = toCsv(["Client", "Balance", "Overdue", "Services", "Invoices"], r.clients.map((c) => [c.clientName, dollars(c.balanceCents), dollars(c.overdueCents), c.services.join("; "), c.invoices.join("; ")]));
  } else {
    return new Response("Unknown export", { status: 400 });
  }
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="owner-${type}-${year}.csv"`, "Cache-Control": "private, no-store" },
  });
}
