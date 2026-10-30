# Deploying TTurner Client Connect on Netlify

## Database: Netlify Database (managed PostgreSQL)

This project uses **Netlify Database** (`@netlify/database`), Netlify's built-in Postgres:

- Netlify **provisions the database automatically** because `@netlify/database` is a dependency.
  There is no connection string to create, copy, paste or store — nothing goes in chat or GitHub.
- At runtime Netlify injects `NETLIFY_DB_URL`; `src/lib/prisma.ts` connects with it.
- Schema changes live in `netlify/database/migrations/` (one folder per migration with `migration.sql`,
  applied in name order). **Netlify applies them itself**: to each deploy preview's database branch
  before the preview is published, and to production just before publish. A failing migration blocks
  the deploy instead of breaking the live site.
- **Migration order matters.** Netlify refuses any migration whose version is not newer than the newest
  migration already applied (it blocks the deploy instead of skipping it), and it also refuses edits to,
  or removal of, a migration that has run. When two branches add migrations, the one merged second must
  carry the newer version: before merging, check that every new migration folder sorts after the newest
  one on `main`. `npm run db:migrate:local` enforces the same rule locally. To fix a blocked deploy, give
  the never-applied migration a newer version (never rename or edit one that has already run).
- The build (`node scripts/check-deploy-env.mjs && npx next build`) never connects to the database and
  never runs migrations — that's why the old `P1012: DATABASE_URL not found` error can't recur.
- Do **not** add a `DATABASE_URL` variable in Netlify; it's ignored there (the build prints a warning).

### What deploys can and can't change

- Migrations create tables, plus one data migration, `seed_default_groups`, which inserts six empty
  client-group names with `ON CONFLICT DO NOTHING` — it never modifies or removes existing rows.
- No deploy creates clients, contacts, staff or client accounts, or passwords. Fictional sample data
  (`npm run db:sample`) and local seeding refuse to run on Netlify.
- The first Admin is created explicitly (below).

### Production vs. preview databases

Each deploy preview / branch deploy runs on **its own database branch, forked from production**. Changes
made in a preview never reach production, but **a preview contains a copy of production client data**,
and preview URLs are shareable. Every page still requires a staff or client login, and preview sessions
use the preview database's accounts. Recommended for a CRM holding tax and financial records:

- **Turn off deploy previews and branch deploys** for this site (Site configuration → Build & deploy →
  Branches and deploy contexts → Deploy Previews: *Don't deploy pull requests*; Branch deploys:
  *Deploy only the production branch*), **or**
- keep them only after you've confirmed with Netlify support/plan settings that previews can be
  password-protected, and treat preview links as confidential.

Your choice — I haven't changed Netlify site settings.

## Environment variables to add in Netlify

Site configuration → **Environment variables** → Add a variable. Scopes: **Builds** and **Functions**.
Mark secrets as **Contains secret values**.

| Variable | Value |
|---|---|
| `APP_ENCRYPTION_KEY` | 48 random characters (generate on your own computer: `openssl rand -base64 48`). Set once; changing it resets two-step verification. **Required** — the build stops without it. |
| `APP_URL` | `https://<your-site>.netlify.app` or your domain |
| `SETUP_TOKEN` | 24+ random characters; used once at `/staff/setup`, then delete it |
| `CRON_SECRET` | 32+ random characters (hourly automations) |
| `LIVE_SENDING_ENABLED` | `false` |
| `NOTIFICATIONS_ENABLED` | `false` until email/Twilio are verified |

Optional provider variables are listed in `.env.example` and docs/INTEGRATIONS.md.

## First deploy and first Admin

1. Merge the pull request into `main` (or trigger a deploy). Watch the deploy log for
   "Deployment settings look complete" and the migration step.
2. Open `https://<site>/staff/setup`, enter `SETUP_TOKEN`, your name, email and a strong password.
3. Scan the QR code with an authenticator app; save the recovery codes somewhere safe.
4. Setup locks itself once a staff account exists. Delete `SETUP_TOKEN` from Netlify.
5. Invite Daria: **Settings → Invite a staff member** (one-time link, valid 7 days).

## Verify after deploying

- `/welcome` shows Client Login and Staff Login.
- Staff: sign in → two-step code → dashboard loads (database read).
- Create a clearly fictional test client, then archive it (database write).
- From that client's **Portal & signatures** tab create a portal invitation; open it in a private
  window, set a password and two-step verification; confirm only that account is visible.
- Sign out of both.

## Local development

```bash
cp .env.example .env            # DATABASE_URL = a LOCAL Postgres
npm install
npm run db:migrate:local        # applies netlify/database/migrations locally (refuses non-local hosts)
npm run db:sample               # optional FICTIONAL clients
```

Creating a migration: change `prisma/schema.prisma`, then
`npm run -s db:diff > netlify/database/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql`
(against an up-to-date local database), review the SQL, run `npm run db:migrate:local`, commit both.
Never edit a migration that has been deployed — add a new one.

## Backups and recovery

- Netlify Database is managed Postgres with point-in-time recovery; check your plan's restore window in
  the Netlify UI (Database → Backups/Restore).
- Recommended weekly logical backup from a trusted computer using the Netlify CLI
  (`netlify database connect` gives a connection for `pg_dump -Fc`), stored in encrypted storage —
  never in GitHub.
- Uploaded files live in Netlify Blobs (`client-connect-documents` for client/tax documents,
  `client-connect-files` for marketing media); export with `netlify blobs:list` / `netlify blobs:get`.

## Upload size

Netlify Functions accept request bodies of about 6 MB, so uploads through the app are capped at 5 MB.
