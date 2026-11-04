-- Tabitha's review of the bookkeeping workflow (PR #82):
-- * Coetha's ROUTINE document requests go out automatically by default (she can turn it off);
--   unusual, sensitive or unclear requests are routed to her review queue.
-- * Interim financial statements Tabitha releases without closing the period.
-- * Plaid Liabilities fields (cards and eligible loans), filled only when that product is enabled.
-- Additive only.

ALTER TABLE "BankConnectionAccount" ADD COLUMN     "aprPercent" DOUBLE PRECISION,
ADD COLUMN     "lastStatementBalanceCents" INTEGER,
ADD COLUMN     "lastStatementDate" DATE,
ADD COLUMN     "liabilitiesAt" TIMESTAMP(3),
ADD COLUMN     "liabilityOverdue" BOOLEAN,
ADD COLUMN     "minimumPaymentCents" INTEGER,
ADD COLUMN     "nextPaymentDueDate" DATE;

ALTER TABLE "DocumentRequest" ADD COLUMN     "routing" TEXT,
ADD COLUMN     "routingReason" TEXT;
ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_routing_check" CHECK ("routing" IS NULL OR "routing" IN ('ROUTINE', 'REVIEW'));

-- Auto-send for routine requests is on by default. A setting Tabitha already changed herself is kept.
ALTER TABLE "IntegrationSettings" ALTER COLUMN "coethaAutoSendRequests" SET DEFAULT true;
UPDATE "IntegrationSettings" SET "coethaAutoSendRequests" = true WHERE "coethaAutoSendChangedAt" IS NULL;

CREATE TABLE "InterimStatement" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "asOf" DATE NOT NULL,
    "purpose" TEXT,
    "releasedById" TEXT NOT NULL,
    "releasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "InterimStatement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InterimStatement_dates_check" CHECK ("fromDate" <= "asOf")
);
CREATE INDEX "InterimStatement_clientId_releasedAt_idx" ON "InterimStatement"("clientId", "releasedAt");
ALTER TABLE "InterimStatement" ADD CONSTRAINT "InterimStatement_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
