import { timingSafeEqual } from "node:crypto";
import { heartbeat } from "@/lib/services/documents";
import { sweepDocumentOwnership } from "@/lib/services/document-ownership";

// Called by netlify/functions/document-ownership-cron.mts with CRON_SECRET.
export const maxDuration = 30;

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    await heartbeat("cron:refused", { route: "document-ownership", secretSet: !!secret }).catch(() => {});
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const r = await sweepDocumentOwnership({ budgetMs: 20_000 });
  await heartbeat("documents:ownership", { checked: r.checked, moved: r.moved, held: r.held }).catch(() => {});
  return Response.json(r);
}
