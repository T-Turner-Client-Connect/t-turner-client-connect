import type { Config } from "@netlify/functions";

// Nightly backup kick-off. Netlify schedules run in UTC: 07:00–10:00 UTC covers 2:00 AM Central in
// both standard (08:00 UTC) and daylight time (07:00 UTC), plus later hours so a run cut off by a
// time limit resumes. The site decides whether a backup is due (after 2:00 AM office time, none yet
// today) and does nothing unless backups are configured and switched on.
// This function only starts the background function, which has up to 15 minutes.
const kickOff = async () => {
  const res = await fetch(`${process.env.URL}/.netlify/functions/backup-runner-background`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  console.log(`backup-nightly: background function HTTP ${res.status}`);
};

export default kickOff;

export const config: Config = { schedule: "0 7-10 * * *" };
