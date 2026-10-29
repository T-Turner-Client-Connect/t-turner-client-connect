# Deploying TTurner Client Connect on Netlify

## Database: what this project expects

- **PostgreSQL 14 or newer**, reached through Prisma using one environment variable, `DATABASE_URL`.
- Any managed Postgres works. The simplest options with Netlify are:
  - **Neon** (serverless Postgres, free tier, built-in branching for preview databases) — recommended.
  - Netlify DB (which is Neon, provisioned from the Netlify dashboard).
  - Supabase or another hosted Postgres.
- Use the **direct** connection string, not the pooled/PgBouncer one (Neon pooled hosts contain `-pooler`):
  Prisma migrations need a direct connection. Add `?sslmode=require`.

The build fails early with a plain-English message if `DATABASE_URL` is missing, points at localhost,
uses a pooled host, or lacks SSL (`scripts/check-deploy-env.mjs`).

## 1. Create the databases (production and preview are separate)

With Neon (neon.tech → sign in with GitHub or email):

1. **Create project** → name `tturner-client-connect`, Postgres 16, region nearest you (e.g. US East).
2. The default branch (`main`) is **production**. Copy nothing yet.
3. **Branches → Create branch** → name `preview`, from `main`. This is a separate database for deploy previews.
4. For each branch: **Connection details** → choose the branch → turn **Connection pooling off** → copy the
   connection string. It looks like `postgresql://USER:PASSWORD@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require`.
   Paste it **only** into Netlify (next step) — never into chat, email, or GitHub.

## 2. Add environment variables in Netlify

Netlify → your site → **Site configuration → Environment variables → Add a variable → Add a single variable**.
For each variable below choose **Scopes: Builds and Functions** (functions = server runtime), then
**Values: Different value for each deploy context** where noted.

| Variable | Value | Contexts |
|---|---|---|
| `DATABASE_URL` | Neon **main** direct string | Production |
| `DATABASE_URL` | Neon **preview** direct string | Deploy previews, Branch deploys |
| `APP_ENCRYPTION_KEY` | 48 random characters (`openssl rand -base64 48`) — different per context | all |
| `APP_URL` | `https://<your-site>.netlify.app` (or your domain) | Production |
| `SETUP_TOKEN` | 24+ random characters, used once at `/staff/setup` | Production (and previews if needed) |
| `CRON_SECRET` | 32+ random characters | all |
| `LIVE_SENDING_ENABLED` | `false` | all |
| `NOTIFICATIONS_ENABLED` | `false` until email/Twilio are verified | all |

Tick **"Contains secret values"** for `DATABASE_URL`, `APP_ENCRYPTION_KEY`, `SETUP_TOKEN`, `CRON_SECRET`
and any provider keys. Optional provider variables are listed in `.env.example`.

> Changing `APP_ENCRYPTION_KEY` later invalidates two-step-verification enrolments; set it once and keep it.

## 3. Deploy

Trigger a deploy (Deploys → Trigger deploy → Deploy site). The build runs:

```
node scripts/check-deploy-env.mjs && npx prisma migrate deploy && npx next build
```

- `prisma migrate deploy` only applies schema migrations. **Deploys never create data**: no sample
  clients, no accounts, no passwords, and they never overwrite rows.
- Fictional sample data (`npm run db:sample`) refuses to run against a non-local database.

## 4. First Admin (explicit, one time)

1. Open `https://<site>/staff/setup`, enter the `SETUP_TOKEN`, your name, email and a strong password.
2. Scan the QR code with an authenticator app and store the recovery codes.
3. The setup page locks itself once any staff account exists. Remove or rotate `SETUP_TOKEN` in Netlify.
4. Invite Daria from **Settings → Invite a staff member** (one-time link, 7 days).
5. Groups: **Clients → Groups → Add suggested groups** (Admin only).

## 5. Verify after deploying

- `/welcome` shows Client Login and Staff Login.
- Staff: sign in → two-step code → dashboard loads (database read).
- Add a fictional test client, then archive it (database write).
- Client: from that client's **Portal & signatures** tab create an invitation, open the link in a private
  window, set a password and two-step verification, and confirm the client sees only that account.
- Sign out of both.

## Backups and recovery

- Neon keeps point-in-time history (restore window depends on plan: 1 day free, up to 30 days paid).
  Restore: Neon → Branches → `main` → **Restore** to a timestamp, or create a branch from a past time and
  repoint `DATABASE_URL`.
- Weekly logical backup (recommended): from a trusted computer,
  `pg_dump "$DATABASE_URL" -Fc -f tturner-$(date +%F).dump`, stored in encrypted storage — never in GitHub.
- Uploaded files are in Netlify Blobs stores `client-connect-documents` (client/tax documents) and
  `client-connect-files` (marketing media). They are tied to the site; export with the Netlify CLI
  (`netlify blobs:list` / `blobs:get`) for off-site copies.

## Upload size

Netlify Functions accept request bodies of about 6 MB, so uploads through the app are capped at 5 MB.
Larger videos for social media need direct-to-storage uploads (planned with direct social publishing).
