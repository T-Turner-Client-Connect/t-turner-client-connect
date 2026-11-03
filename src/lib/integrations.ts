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

/**
 * True on Netlify deploy previews and branch deploys. Those run against their
 * own copy of the database, so anything they create (invitations, codes) only
 * exists there.
 */
export function isPreviewDeploy(): boolean {
  const c = process.env.BUILD_CONTEXT || process.env.CONTEXT || "";
  return c === "deploy-preview" || c === "branch-deploy";
}

/**
 * The address used in links. A preview links to itself — never to
 * production, whose database has never seen the preview's invitations.
 */
export function appUrl(): string {
  const preview = isPreviewDeploy() ? process.env.BUILD_DEPLOY_URL || process.env.DEPLOY_PRIME_URL : "";
  return (preview || process.env.APP_URL || process.env.URL || "http://localhost:3000").replace(/\/$/, "");
}
