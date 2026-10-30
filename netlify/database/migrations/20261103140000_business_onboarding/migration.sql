-- AlterTable
ALTER TABLE "BookkeepingAccount" ADD COLUMN     "accessMethod" TEXT;

-- AlterTable
ALTER TABLE "BookkeepingBilling" ADD COLUMN     "cardBrand" TEXT,
ADD COLUMN     "cardExpMonth" INTEGER,
ADD COLUMN     "cardExpYear" INTEGER,
ADD COLUMN     "cardLast4" TEXT,
ADD COLUMN     "cardSavedAt" TIMESTAMP(3),
ADD COLUMN     "tierName" TEXT;

-- AlterTable
ALTER TABLE "BookkeepingProfile" ADD COLUMN     "contactEmail" TEXT,
ADD COLUMN     "einHash" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedById" TEXT;

-- AlterTable
ALTER TABLE "RecurringChargeAuthorization" ADD COLUMN     "authorizedByPortalUserId" TEXT,
ADD COLUMN     "cardLast4" TEXT,
ADD COLUMN     "termsText" TEXT;


-- CreateTable
CREATE TABLE "BusinessOnboarding" (
    "clientId" TEXT NOT NULL,
    "relationship" TEXT,
    "wantsBookkeeping" BOOLEAN,
    "draft" JSONB,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "submittedAt" TIMESTAMP(3),
    "updatedByPortalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessOnboarding_pkey" PRIMARY KEY ("clientId")
);

-- CreateTable
CREATE TABLE "BusinessInfoChange" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "possibleDuplicateIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "submittedByPortalId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,

    CONSTRAINT "BusinessInfoChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessInfoChange_clientId_status_idx" ON "BusinessInfoChange"("clientId", "status");

-- AddForeignKey
ALTER TABLE "BusinessOnboarding" ADD CONSTRAINT "BusinessOnboarding_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessInfoChange" ADD CONSTRAINT "BusinessInfoChange_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

