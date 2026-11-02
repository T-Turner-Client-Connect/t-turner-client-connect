-- Formation packages (owner-editable) and package deliverables on the nonprofit checklist.
-- Adds columns with defaults and one new table; no existing data is removed.
-- Deliverables are the documents T. Turner & Associates provides (its Bizee-based workflow),
-- tracked separately from government requirements; an item can be both.

-- AlterTable
ALTER TABLE "NonprofitChecklistItem" ADD COLUMN     "deliverable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requirement" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "section" TEXT NOT NULL DEFAULT 'OTHER';

-- AlterTable
ALTER TABLE "NonprofitPortfolio" ADD COLUMN     "govFeesMode" TEXT,
ADD COLUMN     "packageKey" TEXT,
ADD COLUMN     "serviceId" TEXT;

-- CreateTable
CREATE TABLE "NonprofitPackage" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "priceNote" TEXT,
    "statePrices" JSONB,
    "govFeesMode" TEXT NOT NULL DEFAULT 'ADDED',
    "deliverables" JSONB NOT NULL,
    "grantDisclaimer" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NonprofitPackage_pkey" PRIMARY KEY ("key")
);

-- Existing checklist items came from state templates: they're government requirements. Sort them into sections.
UPDATE "NonprofitChecklistItem" SET "requirement" = true WHERE "templateKey" IS NOT NULL;
UPDATE "NonprofitChecklistItem" SET "section" = CASE
  WHEN "templateKey" IN ('sos_formation','state_formation','ein','incorporator_statement','org_minutes','bylaws','bank_resolution') OR "category" = 'GOVERNANCE' THEN 'FORMATION'
  WHEN "templateKey" LIKE 'irs\_%' THEN 'IRS'
  WHEN "category" = 'STATE' THEN 'STATE'
  WHEN "category" = 'GRANT' THEN 'GRANT'
  ELSE 'OTHER' END;

-- Starting packages (owner-editable in Nonprofit settings).
INSERT INTO "NonprofitPackage" ("key", "name", "priceCents", "priceNote", "govFeesMode", "deliverables", "grantDisclaimer", "sortOrder", "updatedAt") VALUES
  ('AL_BASIC', 'Alabama Basic Nonprofit Formation', 250000, NULL, 'ADDED', '[{"key": "sos_formation", "label": "Filed Articles of Incorporation", "section": "FORMATION"}, {"key": "incorporator_statement", "label": "Statement of the Incorporator", "section": "FORMATION"}, {"key": "ein", "label": "EIN / Tax ID confirmation", "section": "FORMATION"}, {"key": "org_minutes", "label": "Organizational meeting minutes", "section": "FORMATION"}, {"key": "bylaws", "label": "Corporate bylaws", "section": "FORMATION"}, {"key": "bank_resolution", "label": "Banking resolution", "section": "FORMATION"}, {"key": "irs_application", "label": "501(c)(3) application preparation and filing assistance", "section": "IRS"}, {"key": "irs_submission", "label": "IRS application submission confirmation", "section": "IRS"}, {"key": "irs_determination", "label": "IRS determination letter (when issued)", "section": "IRS"}]'::jsonb, false, 1, CURRENT_TIMESTAMP),
  ('OTHER_STATE', 'Other-State Nonprofit Formation', 350000, 'Starting at', 'ADDED', '[{"key": "sos_formation", "label": "Filed Articles of Incorporation", "section": "FORMATION"}, {"key": "incorporator_statement", "label": "Statement of the Incorporator", "section": "FORMATION"}, {"key": "ein", "label": "EIN / Tax ID confirmation", "section": "FORMATION"}, {"key": "org_minutes", "label": "Organizational meeting minutes", "section": "FORMATION"}, {"key": "bylaws", "label": "Corporate bylaws", "section": "FORMATION"}, {"key": "bank_resolution", "label": "Banking resolution", "section": "FORMATION"}, {"key": "irs_application", "label": "501(c)(3) application preparation and filing assistance", "section": "IRS"}, {"key": "irs_submission", "label": "IRS application submission confirmation", "section": "IRS"}, {"key": "irs_determination", "label": "IRS determination letter (when issued)", "section": "IRS"}]'::jsonb, false, 2, CURRENT_TIMESTAMP),
  ('COMPLETE', 'Complete Nonprofit Portfolio', 500000, NULL, 'ADDED', '[{"key": "sos_formation", "label": "Filed Articles of Incorporation", "section": "FORMATION"}, {"key": "incorporator_statement", "label": "Statement of the Incorporator", "section": "FORMATION"}, {"key": "ein", "label": "EIN / Tax ID confirmation", "section": "FORMATION"}, {"key": "org_minutes", "label": "Organizational meeting minutes", "section": "FORMATION"}, {"key": "bylaws", "label": "Corporate bylaws", "section": "FORMATION"}, {"key": "bank_resolution", "label": "Banking resolution", "section": "FORMATION"}, {"key": "irs_application", "label": "501(c)(3) application preparation and filing assistance", "section": "IRS"}, {"key": "irs_submission", "label": "IRS application submission confirmation", "section": "IRS"}, {"key": "irs_determination", "label": "IRS determination letter (when issued)", "section": "IRS"}, {"key": "sam_registration", "label": "SAM.gov registration assistance", "section": "SAM"}, {"key": "uei", "label": "Unique Entity ID (UEI)", "section": "SAM"}, {"key": "grant_documents", "label": "Grant-readiness document preparation", "section": "GRANT"}, {"key": "mission_programs", "label": "Organization mission and program information", "section": "GRANT"}, {"key": "board_governance", "label": "Board and governance documentation", "section": "GRANT"}, {"key": "grant_checklist", "label": "Grant-readiness checklist", "section": "GRANT"}, {"key": "funding_guidance", "label": "Funding application preparation guidance", "section": "GRANT"}]'::jsonb, true, 3, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
