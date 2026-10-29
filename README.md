# TTurner Client Connect

Private CRM and secure client portal for TTurner & Associates Group, LLC — clients, conversations,
bookkeeping, tax filings, campaigns, social media and follow-ups.

- **Staff Login**: `/staff/login` · **Client Login**: `/client/login` · chooser at `/welcome`
- Deploying: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- What's connected vs. awaiting setup: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)
- Architecture, data model and stages: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Local development

```bash
cp .env.example .env          # a LOCAL DATABASE_URL and APP_ENCRYPTION_KEY
npm install
npm run db:migrate:local      # applies netlify/database/migrations (local only)
npm run db:sample             # FICTIONAL sample clients (refuses non-local databases)
SETUP_TOKEN=local-setup-token-123 npm run dev
```

Open http://localhost:3000/staff/setup to create the first Admin.

## Checks

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

Tests need a local Postgres database (`TEST_DATABASE_URL`, default `postgresql://crm:crm@localhost:5432/crm_test`), migrated with `DATABASE_URL=<test db> npm run db:migrate:local`.

Production uses Netlify Database — see docs/DEPLOYMENT.md.

## Brand

- Logo: `public/brand/logo.png` (mark and full lockups in the same folder)
- Navy `#001452` · Gold `#D2A43F` (accents only; text uses `#6B4E10` on light backgrounds) · Ivory `#F8F4EA`

Client data never belongs in this repository. Use fictional data in development.
