-- Jotform questionnaire links from the owner (Oct 30, 2026), exactly as given:
--   2022 https://form.jotform.com/252305025862148
--   2023 https://form.jotform.com/252305140388149
--   2024 https://form.jotform.com/252296519455163
--   2025 https://form.jotform.com/252294381123150
-- 2026 is not built yet: its form ID stays empty, so clients see "coming soon".
-- Admins add it later in Settings → Tax questionnaires.
INSERT INTO "TaxQuestionnaire" ("id","taxYear","audience","title","jotformFormId","updatedAt") VALUES
('txq_2022',2022,'ALL','2022 Tax Questionnaire','252305025862148',CURRENT_TIMESTAMP),
('txq_2023',2023,'ALL','2023 Tax Questionnaire','252305140388149',CURRENT_TIMESTAMP),
('txq_2024',2024,'ALL','2024 Tax Questionnaire','252296519455163',CURRENT_TIMESTAMP),
('txq_2025',2025,'ALL','2025 Tax Questionnaire','252294381123150',CURRENT_TIMESTAMP)
ON CONFLICT ("taxYear","audience") DO UPDATE SET "jotformFormId" = EXCLUDED."jotformFormId", "active" = true, "updatedAt" = CURRENT_TIMESTAMP;
