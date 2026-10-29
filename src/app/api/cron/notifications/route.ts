import { timingSafeEqual } from "node:crypto";
import { dispatchPendingNotifications } from "@/lib/services/notifications";
import { dispatchStaffAlerts } from "@/lib/services/staff-alerts";
import { scanQuarantined } from "@/lib/services/documents";

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
  await dispatchPendingNotifications();
  const staffAlerts = await dispatchStaffAlerts();
  return Response.json({ ok: true, staffAlerts, scan });
}
