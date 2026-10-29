// Runs before migrations on every Netlify build. Fails fast with a clear
// message instead of a raw Prisma error, and refuses obviously unsafe
// configurations. Never prints secret values.
const context = process.env.CONTEXT || "local"; // Netlify: production | deploy-preview | branch-deploy | dev
const problems = [];

const db = process.env.DATABASE_URL;
if (!db) {
  problems.push(
    "DATABASE_URL is not set for this deploy context. In Netlify: Site configuration → Environment variables → Add a variable → DATABASE_URL, " +
      "scopes: Builds + Functions, with a separate value for Production and for Deploy Previews/Branch deploys.",
  );
} else {
  let url;
  try {
    url = new URL(db);
  } catch {
    problems.push("DATABASE_URL is not a valid connection string (expected postgresql://…).");
  }
  if (url) {
    if (!/^postgres(ql)?:$/.test(url.protocol)) problems.push("DATABASE_URL must be a PostgreSQL connection string.");
    if (/^(localhost|127\.0\.0\.1)$/.test(url.hostname) && context !== "local") problems.push("DATABASE_URL points at localhost, which doesn't exist on Netlify.");
    if (context !== "local" && !/sslmode=(require|verify-full)/.test(url.search)) problems.push("Add ?sslmode=require to DATABASE_URL so the database connection is encrypted.");
    if (/-pooler\./.test(url.hostname)) {
      problems.push("DATABASE_URL uses a pooled (PgBouncer) host. Use the direct connection string — Prisma migrations need it.");
    }
  }
}

const key = process.env.APP_ENCRYPTION_KEY;
if (context !== "local" && (!key || key.length < 32)) {
  problems.push("APP_ENCRYPTION_KEY is missing or shorter than 32 characters (it protects two-step verification secrets and download links).");
}

if (problems.length) {
  console.error(`\n✖ Deployment configuration problem (${context}):\n  - ${problems.join("\n  - ")}\n`);
  process.exit(1);
}
console.log(`✓ Deployment environment looks complete for context "${context}".`);
