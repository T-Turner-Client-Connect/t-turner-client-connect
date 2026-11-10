import { timingSafeEqual } from "node:crypto";
import { heartbeat } from "@/lib/services/documents";
import { workOnce } from "@/lib/services/coetha-reading";

// One unit of Coetha's background reading (a couple of pages, or one answer), well inside one
// request. Called in a loop by netlify/functions/coetha-reading-background.mts and once by the
// 10-minute scheduled task, with CRON_SECRET.
export const maxDuration = 60;

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    await heartbeat("cron:refused", { route: "coetha-work", secretSet: !!secret }).catch(() => {});
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const r = await workOnce();
  if (r.did) await heartbeat("coetha:reading", { did: r.did }).catch(() => {});
  return Response.json(r);
}
