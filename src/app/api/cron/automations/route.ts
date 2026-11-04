import { timingSafeEqual } from "node:crypto";
import { runAutomations } from "@/lib/services/automations";
import { heartbeat } from "@/lib/services/documents";
import { syncStaleSquareBilling } from "@/lib/services/square-billing";
import { reconcileSquareInvoices } from "@/lib/services/square-invoicing";
import { runDailyBankRetrieval } from "@/lib/services/banking";
import { runDailyCoetha } from "@/lib/services/coetha";
import { runDailyWorkflowMonitor } from "@/lib/services/monthly-workflow";

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
  return Response.json({ ok: true, summary, square, squareInvoices, bank, coetha });
}
