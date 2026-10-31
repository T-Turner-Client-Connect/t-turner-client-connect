-- Nonprofits from any client record: whether an owner has a nonprofit, and whether
-- TTurner handles each organization's annual filings. Two nullable columns; existing data unchanged.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN "hasNonprofit" TEXT;

-- AlterTable
ALTER TABLE "NonprofitProfile" ADD COLUMN "filingService" TEXT;
