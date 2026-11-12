import { timingSafeEqual } from "node:crypto";
import { applyResult, nextCall } from "@/lib/services/coetha-answer";
import type { ChatCallOutcome } from "@/lib/coetha-model";

// Coetha's answer engine, for the background function (CRON_SECRET only):
//   { op: "next" }                               → the next AI call to make, or { idle: true }
//   { op: "result", runId, callId, outcome }     → applies it (tools, or the saved answer) and
//                                                  returns that run's next call, if any
// Each request is short: the AI call itself happens in the background function.
export const maxDuration = 60;

function authorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return !!secret && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { op?: string; runId?: string; callId?: string; outcome?: ChatCallOutcome };
  if (body.op === "result" && body.runId && body.callId && body.outcome) {
    const r = await applyResult(body.runId, body.callId, body.outcome);
    if (r.done) return Response.json({ done: true });
    const next = await nextCall({ runId: body.runId });
    return Response.json(next ?? { idle: true });
  }
  const next = await nextCall();
  return Response.json(next ?? { idle: true });
}
