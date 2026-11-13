import { timingSafeEqual } from "node:crypto";
import { heartbeat } from "@/lib/services/documents";
import { runAutomaticStatements } from "@/lib/services/coetha-statements";

// Builds each month's P&L, Balance Sheet and Financial Statements Package as drafts once the
// month's books are done (see runAutomaticStatements). Called hourly by
// netlify/functions/statements-cron.mts with CRON_SECRET. Drafts only; nothing is released.
export const maxDuration = 30;

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    await heartbeat("cron:refused", { route: "statements", secretSet: !!secret }).catch(() => {});
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  // First: each month's readable statement, proven by its account number, linked to its account.
  const { linkStatementsOnFile } = await import("@/lib/services/statement-choice");
  const links = await linkStatementsOnFile({ budgetMs: 6_000 }).catch((err) => ({ linked: [], skipped: { error: 1, [`error:${err instanceof Error ? err.name : "unknown"}`]: 1 } as Record<string, number>, more: false }));
  const r = await runAutomaticStatements({ budgetMs: 12_000 });
  await heartbeat("statements:auto", { built: "built" in r ? r.built.length : 0, failed: "failed" in r ? r.failed?.length ?? 0 : 0 }).catch(() => {});
  return Response.json({ linked: links.linked.length, linkSkipped: links.skipped, built: r.built.length, failed: "failed" in r ? r.failed : [], more: "more" in r ? r.more : false });
}
