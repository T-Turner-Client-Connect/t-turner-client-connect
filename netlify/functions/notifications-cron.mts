import type { Config } from "@netlify/functions";

// Every 10 minutes: client notices held for quiet hours and staff text alerts
// waiting for the Monday–Friday window (nothing sends unless configured), and one step of
// Coetha's background document reading.
const run = async () => {
  const auth = { Authorization: `Bearer ${process.env.CRON_SECRET}` };
  // Coetha's document reading moves one unit forward too (its own request), in case the
  // background function isn't running.
  const [res, reading] = await Promise.allSettled([
    fetch(`${process.env.URL}/api/cron/notifications`, { method: "POST", headers: auth }),
    fetch(`${process.env.URL}/api/cron/coetha-reading`, { method: "POST", headers: auth }),
  ]);
  console.log(`notifications: HTTP ${res.status === "fulfilled" ? res.value.status : "failed"}; coetha reading: ${reading.status === "fulfilled" ? reading.value.status : "failed"}`);
};

export default run;

export const config: Config = { schedule: "*/10 * * * *" };
