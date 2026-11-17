import type { Config } from "@netlify/functions";

// Every 15 minutes: Coetha checks documents not yet checked (new uploads the after-upload check
// missed, and every existing record) against the client they are filed under. Clearly misfiled
// documents move to the client they belong to; uncertain ones are held staff-only for review.
const run = async () => {
  const res = await fetch(`${process.env.URL}/api/cron/document-ownership`, { method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
  console.log(`document-ownership: HTTP ${res.status} ${await res.text().catch(() => "")}`.slice(0, 500));
};

export default run;

export const config: Config = { schedule: "*/15 * * * *" };
