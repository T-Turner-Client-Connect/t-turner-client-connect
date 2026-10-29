-- Baseline reference data only: default client groups. No client records,
-- no staff accounts. Existing groups with the same name are left untouched.
INSERT INTO "Group" ("id", "name", "description") VALUES
    (gen_random_uuid()::text, 'Individual Tax Clients', 'Individuals we prepare tax returns for'),
    (gen_random_uuid()::text, 'Business Owners', 'Business clients and owners'),
    (gen_random_uuid()::text, 'Bookkeeping', 'Monthly or quarterly bookkeeping clients'),
    (gen_random_uuid()::text, 'Payroll', 'Payroll service clients'),
    (gen_random_uuid()::text, 'Nonprofit Interest', 'Interested in nonprofit formation or compliance'),
    (gen_random_uuid()::text, 'Prospects', 'Not yet clients')
ON CONFLICT ("name") DO NOTHING;
