-- Baseline reference data only (same as prisma/seed.ts) — no client records,
-- no staff accounts. Existing groups with the same name are left untouched.
INSERT INTO "Group" ("id", "name", "description") VALUES
  ('seed_group_individual_tax', 'Individual Tax Clients', 'Individuals we prepare tax returns for'),
  ('seed_group_business_owners', 'Business Owners', 'Business clients and owners'),
  ('seed_group_bookkeeping', 'Bookkeeping', 'Monthly or quarterly bookkeeping clients'),
  ('seed_group_payroll', 'Payroll', 'Payroll service clients'),
  ('seed_group_nonprofit', 'Nonprofit Interest', 'Interested in nonprofit formation or compliance'),
  ('seed_group_prospects', 'Prospects', 'Not yet clients')
ON CONFLICT ("name") DO NOTHING;
