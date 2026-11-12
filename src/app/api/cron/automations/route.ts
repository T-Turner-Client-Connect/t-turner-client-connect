import { timingSafeEqual } from "node:crypto";
import { runAutomations } from "@/lib/services/automations";
import { heartbeat } from "@/lib/services/documents";
import { syncStaleSquareBilling } from "@/lib/services/square-billing";
import { reconcileSquareInvoices } from "@/lib/services/square-invoicing";
import { runDailyBankRetrieval } from "@/lib/services/banking";
import { runDailyCoetha } from "@/lib/services/coetha";
import { runDailyWorkflowMonitor } from "@/lib/services/monthly-workflow";
import { runBillingSchedules } from "@/lib/services/billing-schedules";
import { runAccessReviewReminders } from "@/lib/services/access-review";
import { generateCycles } from "@/lib/services/payroll-taxes";
import { runPayrollReminders } from "@/lib/services/payroll-reminders";
import { auditDeadlineAlerts } from "@/lib/services/audit-center";
import { purgeExpiredHolds } from "@/lib/services/return-gate";

// Called hourly by netlify/functions/automations-cron.mts with CRON_SECRET.
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    // Recorded so the Documents page can show the schedule is reaching the site but being refused.
    await heartbeat("cron:refused", { route: "automations", secretSet: !!secret }).catch(() => {});
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const summary = await runAutomations();
  // Read-only Square refresh, so billing figures stay current without anyone pressing Sync.
  const square = await syncStaleSquareBilling().catch((e) => ({ error: e instanceof Error ? e.message : "failed" }));
  // Backup for a missed Square webhook: re-reads invoices sent through Square and records any payment (reads only).
  const squareInvoices = await reconcileSquareInvoices().catch(() => ({ error: "failed" }));
  // Automatic read-only bank retrieval: every authorized connection at least once a day (real
  // banks only with the Plaid production keys AND Tabitha's "Live bank connections" switch).
  const bank = await runDailyBankRetrieval().catch(() => ({ error: "failed" }));
  // Then Coetha drafts proposals for businesses with newly retrieved rows (her switch and an
  // Anthropic key are required; drafts only, nothing is posted).
  const coetha = await runDailyCoetha().catch(() => ({ error: "failed" }));
  // Coetha's monthly workflow monitor (rules only, no AI call): reconciliations, draft requests and
  // recommendations for Tabitha. Requests go out only if Tabitha's auto-send setting is on.
  const workflow = await runDailyWorkflowMonitor().catch(() => ({ error: "failed" }));
  // Recurring invoice schedules and payment plans Tabitha approved: each due cycle becomes one draft
  // invoice (idempotent). Sent only if she turned on auto-send AND live sending is on; Square only
  // through the existing send path with its own switch. Bookkeeping subscriptions in Square are untouched.
  const schedules = await runBillingSchedules().catch(() => ({ error: "failed" }));
  // Quarterly access review: one owner-only task per review cycle from 14 days before the due date
  // (never two), and one email to the owner — never staff or clients — once the review is due.
  const accessReview = await runAccessReviewReminders().catch(() => "failed");
  // ADP Payroll & Taxes: a rolling 6-week horizon of pay cycles (idempotent; sends nothing), then the
  // payroll reminders. Client reminders are HELD unless the owner's master switch and the client's
  // own switch are on; nothing here submits payroll, files taxes or moves money.
  const payrollCycles = await generateCycles().catch(() => ({ error: "failed" }));
  const payrollReminders = await runPayrollReminders().catch(() => ({ error: "failed" }));
  // Audit response deadlines 14 and 7 days out, and passed: one office task each (idempotent).
  const auditDeadlines = await auditDeadlineAlerts().catch(() => ({ error: "failed" }));
  // Held (unverified) tax returns nobody reviewed within the hold period are removed.
  const expiredReturnHolds = await purgeExpiredHolds().catch(() => ({ error: "failed" }));
  return Response.json({ ok: true, summary, square, squareInvoices, bank, coetha, workflow, schedules, accessReview, payrollCycles, payrollReminders, auditDeadlines, expiredReturnHolds });
}
