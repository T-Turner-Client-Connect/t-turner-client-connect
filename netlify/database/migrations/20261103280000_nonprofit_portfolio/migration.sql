-- Nonprofit Formation & Compliance Center: one portfolio per nonprofit organization record,
-- officers, IRS application history, classification list, state requirement templates,
-- checklist items and their files. New tables only; existing data unchanged.
--
-- Seeded classifications and the Alabama template are DRAFTS (verifiedAt is NULL):
-- the official sites couldn't be reached when this was written. The app shows them as
-- "Not verified" until the owner confirms each against the official source.

-- CreateTable
CREATE TABLE "NonprofitPortfolio" (
    "clientId" TEXT NOT NULL,
    "legalName" TEXT,
    "formationState" TEXT,
    "formationDate" DATE,
    "ein" TEXT,
    "sosEntityNumber" TEXT,
    "sosFilingDate" DATE,
    "registeredAgent" TEXT,
    "registeredAgentAddress" TEXT,
    "classification" TEXT,
    "agStatus" TEXT,
    "agNote" TEXT,
    "agRenewalDate" DATE,
    "samStatus" TEXT,
    "uei" TEXT,
    "samExpiresOn" DATE,
    "mission" TEXT,
    "programs" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NonprofitPortfolio_pkey" PRIMARY KEY ("clientId")
);

-- CreateTable
CREATE TABLE "NonprofitOfficer" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "termStart" DATE,
    "termEnd" DATE,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NonprofitOfficer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NonprofitIrsEvent" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "reference" TEXT,
    "documentId" TEXT,
    "byId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NonprofitIrsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NonprofitClassification" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "process" TEXT NOT NULL,
    "form" TEXT,
    "sourceUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" TIMESTAMP(3),
    "verifiedNote" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NonprofitClassification_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "NonprofitStateTemplate" (
    "state" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "verifiedNote" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NonprofitStateTemplate_pkey" PRIMARY KEY ("state")
);

-- CreateTable
CREATE TABLE "NonprofitChecklistItem" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "templateKey" TEXT,
    "label" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "responsibleId" TEXT,
    "completedAt" TIMESTAMP(3),
    "filingReference" TEXT,
    "staffNote" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NonprofitChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NonprofitItemFile" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,

    CONSTRAINT "NonprofitItemFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NonprofitIrsEvent_portfolioId_at_idx" ON "NonprofitIrsEvent"("portfolioId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "NonprofitChecklistItem_portfolioId_templateKey_key" ON "NonprofitChecklistItem"("portfolioId", "templateKey");

-- CreateIndex
CREATE UNIQUE INDEX "NonprofitItemFile_documentId_key" ON "NonprofitItemFile"("documentId");

-- CreateIndex
CREATE INDEX "NonprofitItemFile_itemId_idx" ON "NonprofitItemFile"("itemId");

-- AddForeignKey
ALTER TABLE "NonprofitPortfolio" ADD CONSTRAINT "NonprofitPortfolio_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NonprofitOfficer" ADD CONSTRAINT "NonprofitOfficer_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "NonprofitPortfolio"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NonprofitIrsEvent" ADD CONSTRAINT "NonprofitIrsEvent_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "NonprofitPortfolio"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NonprofitChecklistItem" ADD CONSTRAINT "NonprofitChecklistItem_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "NonprofitPortfolio"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NonprofitItemFile" ADD CONSTRAINT "NonprofitItemFile_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "NonprofitChecklistItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Starting classification list (owner-editable; unverified).
INSERT INTO "NonprofitClassification" ("key", "label", "process", "form", "sourceUrl", "active", "sortOrder", "updatedAt") VALUES
  ('501C3', '501(c)(3) — charitable, religious, educational and similar', 'Most organizations apply on Form 1023, or Form 1023-EZ if they pass the IRS eligibility worksheet. Some (for example, churches) aren''t required to apply. DRAFT — confirm on irs.gov before relying on it.', '1023 / 1023-EZ', 'https://www.irs.gov/charities-non-profits/applying-for-tax-exempt-status', true, 0, CURRENT_TIMESTAMP),
  ('501C4', '501(c)(4) — social welfare', 'Notify the IRS on Form 8976 within 60 days of formation; a determination may be requested on Form 1024-A. Not Form 1023. DRAFT — confirm on irs.gov.', '8976; 1024-A (optional)', 'https://www.irs.gov/charities-non-profits/applying-for-tax-exempt-status', true, 1, CURRENT_TIMESTAMP),
  ('501C5', '501(c)(5) — labor, agricultural, horticultural', 'Applies on Form 1024. DRAFT — confirm on irs.gov.', '1024', 'https://www.irs.gov/charities-non-profits/applying-for-tax-exempt-status', true, 2, CURRENT_TIMESTAMP),
  ('501C6', '501(c)(6) — business leagues, chambers of commerce', 'Applies on Form 1024. DRAFT — confirm on irs.gov.', '1024', 'https://www.irs.gov/charities-non-profits/applying-for-tax-exempt-status', true, 3, CURRENT_TIMESTAMP),
  ('501C7', '501(c)(7) — social and recreational clubs', 'Applies on Form 1024. DRAFT — confirm on irs.gov.', '1024', 'https://www.irs.gov/charities-non-profits/applying-for-tax-exempt-status', true, 4, CURRENT_TIMESTAMP),
  ('501C8', '501(c)(8) — fraternal beneficiary societies', 'Applies on Form 1024. DRAFT — confirm on irs.gov.', '1024', 'https://www.irs.gov/charities-non-profits/applying-for-tax-exempt-status', true, 5, CURRENT_TIMESTAMP),
  ('501C10', '501(c)(10) — domestic fraternal societies', 'Applies on Form 1024. DRAFT — confirm on irs.gov.', '1024', 'https://www.irs.gov/charities-non-profits/applying-for-tax-exempt-status', true, 6, CURRENT_TIMESTAMP),
  ('501C19', '501(c)(19) — veterans'' organizations', 'Applies on Form 1024. DRAFT — confirm on irs.gov.', '1024', 'https://www.irs.gov/charities-non-profits/applying-for-tax-exempt-status', true, 7, CURRENT_TIMESTAMP),
  ('501C25', '501(c)(25) — title-holding corporations', 'Applies on Form 1024. DRAFT — confirm on irs.gov.', '1024', 'https://www.irs.gov/charities-non-profits/applying-for-tax-exempt-status', true, 8, CURRENT_TIMESTAMP),
  ('OTHER', 'Other / To be determined', 'Classification not decided. Choose one before preparing an IRS application.', NULL, 'https://www.irs.gov/charities-non-profits/applying-for-tax-exempt-status', true, 9, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- Starting Alabama template (owner-editable; unverified).
INSERT INTO "NonprofitStateTemplate" ("state", "items", "updatedAt") VALUES
  ('AL', '[{"key": "sos_formation", "label": "Formation filing with the Alabama Secretary of State (articles / certificate of formation)", "category": "STATE", "required": true, "note": "Confirm the current form name and fee on the Secretary of State''s site.", "sourceUrl": "https://www.sos.alabama.gov/business-entities"}, {"key": "ein", "label": "EIN confirmation (IRS)", "category": "FEDERAL", "required": true, "note": "", "sourceUrl": "https://www.irs.gov/businesses/small-businesses-self-employed/employer-identification-number"}, {"key": "incorporator_statement", "label": "Statement of Incorporation / Incorporator Statement", "category": "GOVERNANCE", "required": true, "note": "", "sourceUrl": null}, {"key": "org_minutes", "label": "Organizational meeting minutes", "category": "GOVERNANCE", "required": true, "note": "", "sourceUrl": null}, {"key": "bylaws", "label": "Corporate bylaws", "category": "GOVERNANCE", "required": true, "note": "", "sourceUrl": null}, {"key": "bank_resolution", "label": "Banking resolution", "category": "GOVERNANCE", "required": true, "note": "", "sourceUrl": null}, {"key": "irs_application", "label": "Federal tax-exemption application (form depends on the classification)", "category": "FEDERAL", "required": true, "note": "Not every classification uses Form 1023.", "sourceUrl": "https://www.irs.gov/charities-non-profits/applying-for-tax-exempt-status"}, {"key": "irs_submission", "label": "IRS application submission confirmation", "category": "FEDERAL", "required": true, "note": "", "sourceUrl": null}, {"key": "irs_determination", "label": "IRS determination letter (when issued)", "category": "FEDERAL", "required": true, "note": "", "sourceUrl": null}, {"key": "ag_charitable", "label": "Attorney General charitable solicitation \u2014 registration or exemption review", "category": "STATE", "required": false, "note": "Registration may be required before soliciting in Alabama, and some organizations are exempt. Record the review result; don''t assume either.", "sourceUrl": "https://www.alabamaag.gov/"}, {"key": "state_annual", "label": "Annual state filings and renewals review (Secretary of State, Attorney General, Department of Revenue)", "category": "STATE", "required": true, "note": "Confirm which annual filings and renewals apply.", "sourceUrl": "https://www.revenue.alabama.gov/"}]'::jsonb, CURRENT_TIMESTAMP)
ON CONFLICT ("state") DO NOTHING;
