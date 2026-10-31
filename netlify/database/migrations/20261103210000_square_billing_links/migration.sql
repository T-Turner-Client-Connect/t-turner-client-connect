-- Links existing Square recurring billing (read-only). Adds tables and one flag; changes no existing data except marking current bookkeeping clients as already billed through Square.
-- AlterTable
ALTER TABLE "BookkeepingProfile" ADD COLUMN     "squareBillingExpected" BOOLEAN NOT NULL DEFAULT false;


-- CreateTable
CREATE TABLE "SquareBillingArrangement" (
    "id" TEXT NOT NULL,
    "squareCustomerId" TEXT NOT NULL,
    "squareLocationId" TEXT NOT NULL,
    "seriesKey" TEXT NOT NULL,
    "customerName" TEXT,
    "companyName" TEXT,
    "title" TEXT,
    "amountCents" INTEGER,
    "cadence" TEXT,
    "dueDay" INTEGER,
    "nextDueDate" TIMESTAMP(3),
    "nextInvoiceStatus" TEXT,
    "lastDueDate" TIMESTAMP(3),
    "lastInvoiceStatus" TEXT,
    "lastPaidDueDate" TIMESTAMP(3),
    "autopay" BOOLEAN NOT NULL DEFAULT false,
    "squareCardId" TEXT,
    "cardBrand" TEXT,
    "cardLast4" TEXT,
    "cardExpMonth" INTEGER,
    "cardExpYear" INTEGER,
    "invoiceCount" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3),
    "syncError" TEXT,
    "authorizationVerifiedAt" TIMESTAMP(3),
    "authorizationVerifiedById" TEXT,
    "authorizationNote" TEXT,
    "linkedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SquareBillingArrangement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SquareBillingMember" (
    "id" TEXT NOT NULL,
    "arrangementId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SquareBillingMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SquareBillingArrangement_squareCustomerId_idx" ON "SquareBillingArrangement"("squareCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "SquareBillingArrangement_squareLocationId_seriesKey_key" ON "SquareBillingArrangement"("squareLocationId", "seriesKey");

-- CreateIndex
CREATE UNIQUE INDEX "SquareBillingMember_clientId_key" ON "SquareBillingMember"("clientId");

-- CreateIndex
CREATE INDEX "SquareBillingMember_arrangementId_idx" ON "SquareBillingMember"("arrangementId");

-- AddForeignKey
ALTER TABLE "SquareBillingMember" ADD CONSTRAINT "SquareBillingMember_arrangementId_fkey" FOREIGN KEY ("arrangementId") REFERENCES "SquareBillingArrangement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquareBillingMember" ADD CONSTRAINT "SquareBillingMember_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Every client already on the bookkeeping list pays through recurring billing set up in Square.
UPDATE "BookkeepingProfile" SET "squareBillingExpected" = true;
