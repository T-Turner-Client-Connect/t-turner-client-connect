import { timingSafeEqual } from "node:crypto";
import type { Config } from "@netlify/functions";

// Background function (the "-background" suffix gives it up to 15 minutes). Started when files are
// sent to Coetha (with CRON_SECRET). It calls the site's reading endpoint in a loop — each call
// reads a couple of pages or writes one answer and saves its place — until nothing is left or
// ~13 minutes pass. Anything left is continued by the 10-minute scheduled task or the open page.
const BUDGET_MS = 13 * 60 * 1000;

function authorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return !!secret && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

export default async (req: Request) => {
  if (!authorized(req)) {
    console.log("coetha-reading: refused (CRON_SECRET missing or wrong)");
    return;
  }
  const started = Date.now();
  let units = 0;
  while (Date.now() - started < BUDGET_MS) {
    const res = await fetch(`${process.env.URL}/api/cron/coetha-reading`, { method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } }).catch(() => null);
    if (!res || !res.ok) {
      console.log(`coetha-reading: step HTTP ${res?.status ?? "no response"}`);
      // A step that was cut off: its lease runs out and the next call continues from the saved place.
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as { did?: string | null; more?: boolean };
    units++;
    if (!body.more) break;
    // Waiting on a retry delay or a virus scan: check again shortly.
    if (!body.did) await new Promise((r) => setTimeout(r, 15000));
  }
  console.log(`coetha-reading: ${units} unit(s) in ${Math.round((Date.now() - started) / 1000)} s`);
};

export const config: Config = { background: true };
