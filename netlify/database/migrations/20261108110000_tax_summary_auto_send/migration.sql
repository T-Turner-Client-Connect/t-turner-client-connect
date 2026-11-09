-- Automatic Client Tax Summary: Tabitha's owner switch "Send tax summaries automatically".
-- Additive only: three nullable columns on IntegrationSettings. NULL means never set, which is OFF.
-- Parsed return figures are stored in existing columns (TaxSummaryItem.returnAmounts and
-- TaxReturnSummary.returnTotals), so no other table changes.

-- AlterTable
ALTER TABLE "IntegrationSettings" ADD COLUMN "taxSummaryAutoSend" BOOLEAN,
ADD COLUMN "taxSummaryAutoSendById" TEXT,
ADD COLUMN "taxSummaryAutoSendAt" TIMESTAMP(3);
