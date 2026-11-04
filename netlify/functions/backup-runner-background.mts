import { timingSafeEqual } from "node:crypto";
import type { Config } from "@netlify/functions";

// Background function (the "-background" suffix gives it up to 15 minutes). Started by
// backup-nightly.mts with CRON_SECRET. It calls the site's backup step endpoint in a loop — each
// call does ~15 seconds of work and saves its place — until the backup is done, fails, or ~13
// minutes pass. A run that isn't finished resumes on the next scheduled hour.
const BUDGET_MS = 13 * 60 * 1000;

function authorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return !!secret && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

export default async (req: Request) => {
  if (!authorized(req)) {
    console.log("backup-runner: refused (CRON_SECRET missing or wrong)");
    return;
  }
  const started = Date.now();
  let steps = 0;
  while (Date.now() - started < BUDGET_MS) {
    const res = await fetch(`${process.env.URL}/api/cron/backup`, { method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
    steps++;
    if (!res.ok) {
      console.log(`backup-runner: step HTTP ${res.status}`);
      break;
    }
    const body = (await res.json().catch(() => ({}))) as { state?: string; phase?: string };
    if (body.state !== "progress") {
      console.log(`backup-runner: ${body.state ?? "unknown"} after ${steps} step(s)`);
      break;
    }
  }
};

export const config: Config = { background: true };
