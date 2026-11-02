-- Live, read-only Square connection checks (never stores the token).
CREATE TABLE "SquareHealthCheck" (
    "id" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN NOT NULL,
    "environment" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "checkedById" TEXT,
    CONSTRAINT "SquareHealthCheck_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SquareHealthCheck_checkedAt_idx" ON "SquareHealthCheck"("checkedAt");

-- Read-only figures from Square for the billing display.
ALTER TABLE "SquareBillingArrangement" ADD COLUMN "lastPaidCents" INTEGER;
ALTER TABLE "SquareBillingArrangement" ADD COLUMN "outstandingCents" INTEGER;
ALTER TABLE "SquareBillingArrangement" ADD COLUMN "outstandingCount" INTEGER;
ALTER TABLE "SquareBillingArrangement" ADD COLUMN "overdueCents" INTEGER;
ALTER TABLE "SquareBillingArrangement" ADD COLUMN "overdueCount" INTEGER;
ALTER TABLE "SquareBillingArrangement" ADD COLUMN "syncFailedAt" TIMESTAMP(3);
ALTER TABLE "SquareBillingArrangement" ADD COLUMN "failedCount" INTEGER;

-- Prevents overlapping runs of scheduled jobs.
CREATE TABLE "JobLock" (
    "name" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3) NOT NULL,
    "runId" TEXT,
    CONSTRAINT "JobLock_pkey" PRIMARY KEY ("name")
);
ALTER TABLE "SquareBillingArrangement" ADD COLUMN "paidMonth" TEXT;
ALTER TABLE "SquareBillingArrangement" ADD COLUMN "paidMonthCents" INTEGER;
