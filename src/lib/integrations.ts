import "server-only";

/**
 * What's configured. Live sending stays off until every item is in place
 * and an Admin explicitly enables it (stage 2).
 */
export function integrationStatus() {
  const env = process.env;
  return {
    database: Boolean(env.DATABASE_URL || env.NETLIFY_DB_URL),
    appUrl: Boolean(env.APP_URL),
    email: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM_ADDRESS),
    emailWebhook: Boolean(env.RESEND_WEBHOOK_SECRET),
    twilio: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_MESSAGING_SERVICE_SID || env.TWILIO_FROM_NUMBER)),
    liveSendingFlag: env.LIVE_SENDING_ENABLED === "true",
  };
}

export function appUrl(): string {
  return (process.env.APP_URL || process.env.URL || "http://localhost:3000").replace(/\/$/, "");
}
