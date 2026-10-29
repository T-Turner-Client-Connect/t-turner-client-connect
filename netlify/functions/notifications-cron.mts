import type { Config } from "@netlify/functions";

// Every 10 minutes: client notices held for quiet hours and staff text alerts
// waiting for the Monday–Friday window. Nothing sends unless configured.
const run = async () => {
  const res = await fetch(`${process.env.URL}/api/cron/notifications`, { method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
  console.log(`notifications: HTTP ${res.status}`);
};

export default run;

export const config: Config = { schedule: "*/10 * * * *" };
