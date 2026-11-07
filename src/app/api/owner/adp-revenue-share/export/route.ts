import { getCurrentUser } from "@/lib/auth/session";
import { primaryOwnerAccess } from "@/lib/auth/owner";
import { dollars, toCsv } from "@/lib/csv";
import { LINE_TYPE_LABELS, PAYMENT_METHOD_LABELS, REFERRAL_STATUS_LABELS, productLabel, reportParams, ymdOf, type LineType, type ReferralStatus } from "@/lib/adp-revenue-share";
import { adpReport, listPayments, listReferrals, listStatements, getStatement, referralName } from "@/lib/services/adp-revenue-share";

// ADP Revenue Share CSV exports. The owner only: anyone else gets the same 404 as a missing page.
export async function GET(req: Request) {
  const actor = await getCurrentUser();
  if (!actor || !(await primaryOwnerAccess(actor.id))) return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  let csv: string;
  let name: string;
  if (type === "report") {
    const p = reportParams(Object.fromEntries(url.searchParams));
    const r = await adpReport(actor, p);
    const amounts = (x: { earnedCents: number; receivedCents: number; outstandingCents: number }) => [dollars(x.earnedCents), dollars(x.receivedCents), dollars(x.outstandingCents)];
    const period = p.month ? `${p.year}-${String(p.month).padStart(2, "0")}` : String(p.year);
    const rows: unknown[][] = [
      ...r.months.map((m) => ["Month", `${p.year}-${m.key.padStart(2, "0")}`, ...amounts(m)]),
      ["Month", `${p.year} total`, ...amounts(r.yearTotal)],
      ...r.years.map((y) => ["Year", y.key, ...amounts(y)]),
      ...r.byClient.map((c) => ["By client", `${period}: ${c.label}`, ...amounts(c)]),
      ...r.byProduct.map((c) => ["By product", `${period}: ${c.label}`, ...amounts(c)]),
    ];
    csv = toCsv(["View", "Period / group", "Earned", "Received", "Outstanding"], rows);
    name = `adp-revenue-share-report-${period}-${p.basis === "periodEnd" ? "by-period-end" : "by-statement-date"}.csv`;
  } else if (type === "referrals") {
    const rows = await listReferrals(actor);
    csv = toCsv(
      ["Referred on", "Client / prospect", "Linked client", "ADP product", "ADP reference", "Status", "Statement lines", "Notes"],
      rows.map((r) => [ymdOf(r.referredOn), referralName(r), r.clientId ? "yes" : "no", productLabel(r.product, r.productOther), r.adpReference ?? "", REFERRAL_STATUS_LABELS[r.status as ReferralStatus] ?? r.status, r._count.lines, r.notes ?? ""]),
    );
    name = "adp-referrals.csv";
  } else if (type === "statements") {
    const rows = await listStatements(actor);
    csv = toCsv(
      ["Period", "Period start", "Period end", "Statement date", "Status", "Statement total", "Sum of lines", "Difference", "Matched payments", "File"],
      rows.map((s) => [s.periodLabel, ymdOf(s.periodStart), ymdOf(s.periodEnd), ymdOf(s.statementDate), s.status === "FINAL" ? "Final" : "Draft", dollars(s.reportedTotalCents), dollars(s.check.linesCents), dollars(s.check.differenceCents), dollars(s.matchedCents), s.fileName ?? ""]),
    );
    name = "adp-statements.csv";
  } else if (type === "statement") {
    const s = await getStatement(actor, url.searchParams.get("id") ?? "");
    if (!s || s.archivedAt) return new Response("Not found", { status: 404 });
    csv = toCsv(
      ["Period", "Statement date", "Referral / client", "Name on ADP statement", "Type", "Amount", "Note"],
      s.lines.filter((l) => !l.archivedAt).map((l) => [s.periodLabel, ymdOf(s.statementDate), l.referral ? referralName(l.referral) : l.client ? l.client.businessName || l.client.displayName : "", l.adpName ?? "", LINE_TYPE_LABELS[l.type as LineType] ?? l.type, dollars(l.amountCents), l.note ?? ""]),
    );
    name = `adp-statement-${s.periodLabel.replace(/[^\w-]+/g, "-").toLowerCase()}.csv`;
  } else if (type === "payments") {
    const rows = await listPayments(actor);
    csv = toCsv(
      ["Received on", "Amount", "Method", "Period(s) covered", "Reference", "Matched statement", "Note"],
      rows.map((p) => [ymdOf(p.receivedOn), dollars(p.amountCents), p.method === "OTHER" && p.methodOther ? p.methodOther : PAYMENT_METHOD_LABELS[p.method as "ACH"] ?? p.method, p.periodsCovered ?? "", p.reference ?? "", p.statement?.periodLabel ?? "", p.note ?? ""]),
    );
    name = "adp-payments.csv";
  } else {
    return new Response("Unknown export", { status: 400 });
  }
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
