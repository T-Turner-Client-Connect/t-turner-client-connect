// Runs before every Netlify build. The database is Netlify Database: Netlify
// provisions it, injects NETLIFY_DB_URL at runtime and applies the files in
// netlify/database/migrations itself, so the build needs no connection
// string. This check stops the build with a clear message when a required
// runtime setting is missing. It never prints secret values.
import { readFileSync } from "node:fs";

const context = process.env.CONTEXT || "local"; // production | deploy-preview | branch-deploy | dev
const problems = [];
const warnings = [];

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (!pkg.dependencies?.["@netlify/database"]) {
  problems.push("@netlify/database must be a dependency — it is what tells Netlify to provision the database.");
}

if (context !== "local") {
  const key = process.env.APP_ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    problems.push(
      "APP_ENCRYPTION_KEY is missing or shorter than 32 characters. Add it in Netlify → Site configuration → Environment variables (scopes: Builds + Functions, mark as secret).",
    );
  }
  if (process.env.DATABASE_URL) {
    warnings.push("DATABASE_URL is set in Netlify but is ignored — the app uses Netlify Database (NETLIFY_DB_URL). Remove it to avoid confusion.");
  }
}

for (const w of warnings) console.warn(`! ${w}`);
if (problems.length) {
  console.error(`\n✖ Deployment configuration problem (${context}):\n  - ${problems.join("\n  - ")}\n`);
  process.exit(1);
}
console.log(`✓ Deployment settings look complete for context "${context}".`);
