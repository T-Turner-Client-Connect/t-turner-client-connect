import type { Config } from "@netlify/functions";

// Runs reminder automations hourly. Rules are paused by default and nothing
// is delivered unless notifications are enabled and providers are configured.
const runAutomations = async () => {
  const url = `${process.env.URL}/api/cron/automations`;
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
  console.log(`automations: HTTP ${res.status}`);
};

export default runAutomations;

export const config: Config = { schedule: "@hourly" };
