import type { Config } from "@netlify/functions";

// Hourly: builds the month's statements (P&L, Balance Sheet, Financial Statements Package) as
// drafts for Tabitha's approval once the month's books are done. Nothing is released.
const run = async () => {
  const res = await fetch(`${process.env.URL}/api/cron/statements`, { method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
  console.log(`statements: HTTP ${res.status} ${await res.text().catch(() => "")}`.slice(0, 500));
};

export default run;

export const config: Config = { schedule: "@hourly" };
