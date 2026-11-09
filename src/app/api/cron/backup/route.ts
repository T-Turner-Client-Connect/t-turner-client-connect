import { timingSafeEqual } from "node:crypto";
import { heartbeat } from "@/lib/services/documents";
import { backupTick } from "@/lib/backup/runner";

// One bounded step of the nightly backup (about 15 seconds of work). Called in a loop by the
// background function netlify/functions/backup-runner-background.mts, with CRON_SECRET. Does
// nothing unless every BACKUP_* setting is present and the owner's "Nightly backups" switch is on.
export const maxDuration = 60;

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    await heartbeat("cron:refused", { route: "backup", secretSet: !!secret }).catch(() => {});
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const r = await backupTick({ budgetMs: 15_000 });
  await heartbeat("backup:tick", { state: r.state, phase: "phase" in r ? r.phase ?? null : null }).catch(() => {});
  return Response.json(r);
}
