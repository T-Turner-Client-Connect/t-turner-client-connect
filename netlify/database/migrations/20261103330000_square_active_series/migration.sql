-- Only ACTIVE recurring series are shown and totaled. Ended links are kept as history, never deleted.
ALTER TABLE "SquareBillingArrangement" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "SquareBillingArrangement" ADD COLUMN "endedAt" TIMESTAMP(3);
ALTER TABLE "SquareBillingArrangement" ADD COLUMN "endedReason" TEXT;
ALTER TABLE "SquareBillingArrangement" ADD COLUMN "formerClientIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SquareBillingArrangement" ADD COLUMN "needsReview" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SquareBillingArrangement" ADD COLUMN "seriesInvoices" JSONB;

-- The owner's decision on a series Square's invoices can't settle. Nothing in Square is changed.
CREATE TABLE "SquareSeriesReview" (
    "id" TEXT NOT NULL,
    "squareLocationId" TEXT NOT NULL,
    "seriesKey" TEXT NOT NULL,
    "squareCustomerId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "decidedById" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SquareSeriesReview_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SquareSeriesReview_squareLocationId_seriesKey_key" ON "SquareSeriesReview"("squareLocationId", "seriesKey");
