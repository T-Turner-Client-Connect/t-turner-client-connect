-- Tax countdown dates for 2026 returns (filed in 2027), checked Oct 29, 2026
-- against IRS Publication 509 (2026 and the 2027 draft), the Form 4868 draft
-- for 2026, and the Alabama Department of Revenue. Re-check when the IRS
-- releases the final 2027 Publication 509. The 2027 filing-season opening
-- date has not been announced, so no row is added for it.
INSERT INTO "TaxDeadline" ("id","kind","taxYear","jurisdiction","dueDate","notes","sourceUrl","lastReviewedAt","updatedAt") VALUES
('txd_us_2026_individual','INDIVIDUAL',2026,'US','2027-04-15','Calendar-year individuals (Form 1040). Also the deadline to request an extension with Form 4868.','https://www.irs.gov/filing/individuals/when-to-file','2026-10-29 12:00:00',CURRENT_TIMESTAMP),
('txd_us_2026_individual_ext','INDIVIDUAL_EXTENDED',2026,'US','2027-10-15','Only with a valid extension (Form 4868 or an extension payment) made by April 15.','https://www.irs.gov/publications/p509','2026-10-29 12:00:00',CURRENT_TIMESTAMP),
('txd_us_2026_partnership','PARTNERSHIP',2026,'US','2027-03-15','Calendar-year partnerships (Form 1065). Also the deadline to request an extension with Form 7004.','https://www.irs.gov/publications/p509','2026-10-29 12:00:00',CURRENT_TIMESTAMP),
('txd_us_2026_partnership_ext','PARTNERSHIP_EXTENDED',2026,'US','2027-09-15','Only with a valid Form 7004 extension filed by March 15.','https://www.irs.gov/publications/p509','2026-10-29 12:00:00',CURRENT_TIMESTAMP),
('txd_us_2026_scorp','S_CORP',2026,'US','2027-03-15','Calendar-year S corporations (Form 1120-S). Also the deadline to request an extension with Form 7004.','https://www.irs.gov/publications/p509','2026-10-29 12:00:00',CURRENT_TIMESTAMP),
('txd_us_2026_scorp_ext','S_CORP_EXTENDED',2026,'US','2027-09-15','Only with a valid Form 7004 extension filed by March 15.','https://www.irs.gov/publications/p509','2026-10-29 12:00:00',CURRENT_TIMESTAMP),
('txd_us_2026_ccorp','C_CORP',2026,'US','2027-04-15','Calendar-year C corporations (Form 1120). Also the deadline to request an extension with Form 7004.','https://www.irs.gov/publications/p509','2026-10-29 12:00:00',CURRENT_TIMESTAMP),
('txd_us_2026_ccorp_ext','C_CORP_EXTENDED',2026,'US','2027-10-15','Only with a valid Form 7004 extension filed by April 15.','https://www.irs.gov/publications/p509','2026-10-29 12:00:00',CURRENT_TIMESTAMP),
('txd_al_2026_individual','INDIVIDUAL',2026,'AL','2027-04-15','Alabama individual income tax return (Form 40/40A), due with the federal return.','https://www.revenue.alabama.gov/individual-corporate/individual-income-tax-filing-information/','2026-10-29 12:00:00',CURRENT_TIMESTAMP),
('txd_al_2026_individual_ext','INDIVIDUAL_EXTENDED',2026,'AL','2027-10-15','Alabama grants an automatic extension to file; no extension form is required. Payment is still due April 15.','https://www.revenue.alabama.gov/faqs/can-i-apply-for-an-extension-to-file-my-return/','2026-10-29 12:00:00',CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- Questionnaire slots for 2022–2026. Form IDs come from the owner; until
-- then clients see "not available yet — ask our office".
INSERT INTO "TaxQuestionnaire" ("id","taxYear","audience","title","updatedAt") VALUES
('txq_2022','2022','ALL','2022 Tax Questionnaire',CURRENT_TIMESTAMP),
('txq_2023','2023','ALL','2023 Tax Questionnaire',CURRENT_TIMESTAMP),
('txq_2024','2024','ALL','2024 Tax Questionnaire',CURRENT_TIMESTAMP),
('txq_2025','2025','ALL','2025 Tax Questionnaire',CURRENT_TIMESTAMP),
('txq_2026','2026','ALL','2026 Tax Questionnaire',CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;
