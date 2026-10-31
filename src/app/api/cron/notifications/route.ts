import { timingSafeEqual } from "node:crypto";
import { dispatchPendingNotifications } from "@/lib/services/notifications";
import { dispatchStaffAlerts } from "@/lib/services/staff-alerts";
import { scanQuarantined } from "@/lib/services/documents";
import { autoOpenWorkMonth } from "@/lib/services/bookkeeping-questions";
import { runNonprofitReminders } from "@/lib/services/nonprofits";
import { checkResourceLinks } from "@/lib/services/resources";
import { runIdentityReminders } from "@/lib/services/identity";

// Called every 10 minutes by netlify/functions/notifications-cron.mts with CRON_SECRET:
// re-scans quarantined files, sends client notices held for quiet hours and staff alerts
// waiting for the alert window.
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Release files that now scan clean (and send their held notices) before dispatching.
  const scan = await scanQuarantined(50);
  // Bookkeeping: open the work month for every client on the 1st (once a month, Chicago time).
  const periods = await autoOpenWorkMonth();
  // Nonprofit filing reminders (each reminder day sent once).
  const nonprofits = await runNonprofitReminders();
  // License expiration reminders (60/30/7 days) and Expired status; each sent once.
  const identity = await runIdentityReminders();
  await dispatchPendingNotifications();
  const staffAlerts = await dispatchStaffAlerts();
  // A few Resource Center links per run, each re-checked weekly.
  const links = await checkResourceLinks(5, 7);
  return Response.json({ ok: true, staffAlerts, scan, links, identity, periods, nonprofits });
}
