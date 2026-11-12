import { timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "@netlify/functions";

// Background function (up to 15 minutes): makes Coetha's AI calls so an answer is never cut off by
// a page's ~30-second limit. Client Connect (/api/cron/coetha-answer) builds every request, runs
// her tools and saves the answer; this only sends each request to the AI service and returns the
// response. Up to LANES calls at once (the app also caps calls office-wide). Exits when idle.
const BUDGET_MS = 14 * 60 * 1000;
const LANES = 3;

function authorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return !!secret && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

type Call = { runId: string; callId: string; request: Record<string, unknown> };

export default async (req: Request) => {
  if (!authorized(req)) {
    console.log("coetha-answer: refused (CRON_SECRET missing or wrong)");
    return;
  }
  const base = process.env.DEPLOY_URL || process.env.URL;
  const headers = { Authorization: `Bearer ${process.env.CRON_SECRET}`, "Content-Type": "application/json" };
  const api = async (body: unknown): Promise<Call | null> => {
    const res = await fetch(`${base}/api/cron/coetha-answer`, { method: "POST", headers, body: JSON.stringify(body) }).catch(() => null);
    if (!res?.ok) {
      console.log(`coetha-answer: app HTTP ${res?.status ?? "no response"}`);
      return null;
    }
    const j = (await res.json().catch(() => ({}))) as Partial<Call> & { idle?: boolean };
    return j.runId && j.callId && j.request ? (j as Call) : null;
  };
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", maxRetries: 0, timeout: 10 * 60_000 });
  const send = async (request: Record<string, unknown>) => {
    const started = Date.now();
    try {
      const message = await client.beta.messages.create(request as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming);
      return { ok: true, message, ms: Date.now() - started };
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      const retry = err instanceof Anthropic.APIError ? Number(err.headers?.get?.("retry-after") ?? NaN) : NaN;
      const code = err instanceof Anthropic.RateLimitError ? "RATE_LIMIT"
        : status === 529 || status === 500 || status === 502 || status === 503 ? "OVERLOADED"
        : err instanceof Anthropic.APIConnectionTimeoutError ? "TIMEOUT"
        : err instanceof Anthropic.APIConnectionError ? "NETWORK"
        : err instanceof Anthropic.AuthenticationError ? "AUTH"
        : err instanceof Anthropic.PermissionDeniedError ? "PERMISSION"
        : err instanceof Anthropic.BadRequestError ? "BAD_REQUEST"
        : err instanceof Anthropic.NotFoundError ? "MODEL" : "API";
      if (status) console.log(`coetha-answer: AI service HTTP ${status}: ${String((err as Error).message).slice(0, 200)}`);
      const message = code === "RATE_LIMIT" ? "Anthropic's rate limit was reached." : code === "OVERLOADED" ? "The AI service is overloaded." : code === "TIMEOUT" ? "The AI service took too long." : code === "AUTH" ? "The Anthropic API key was refused. Check ANTHROPIC_API_KEY in Netlify." : code === "BAD_REQUEST" ? "Anthropic rejected the request." : code === "MODEL" ? "The model wasn't found. Check COETHA_MODEL." : "The AI service returned an error.";
      return { ok: false, code, message, retryAfterMs: Number.isFinite(retry) ? retry * 1000 : null, ms: Date.now() - started };
    }
  };
  const started = Date.now();
  let answered = 0;
  const lane = async () => {
    let idle = 0;
    while (Date.now() - started < BUDGET_MS) {
      let call = await api({ op: "next" });
      if (!call) {
        // Nothing to do (or every call slot busy / waiting on a retry): look again a few times, then stop.
        if (++idle > 6) return;
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      idle = 0;
      // Follow one run through its rounds (tools, then the answer) without waiting in line again.
      while (call && Date.now() - started < BUDGET_MS) {
        const outcome = await send(call.request);
        const runId = call.runId;
        call = await api({ op: "result", runId, callId: call.callId, outcome });
        if (!call) answered++;
      }
    }
  };
  await Promise.all(Array.from({ length: LANES }, () => lane()));
  console.log(`coetha-answer: ${answered} run step(s) finished in ${Math.round((Date.now() - started) / 1000)} s`);
};

export const config: Config = { background: true };
