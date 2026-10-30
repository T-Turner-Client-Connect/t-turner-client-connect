-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewStatus" TEXT,
ADD COLUMN     "submittedForReviewAt" TIMESTAMP(3),
ADD COLUMN     "submittedForReviewById" TEXT;


-- CreateTable
CREATE TABLE "BookkeepingProfile" (
    "clientId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "frequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "payroll" BOOLEAN NOT NULL DEFAULT false,
    "payrollFrequency" TEXT,
    "payrollProvider" TEXT,
    "accounts" TEXT,
    "notes" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookkeepingProfile_pkey" PRIMARY KEY ("clientId")
);

-- CreateTable
CREATE TABLE "BookkeepingChecklistItem" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "doneById" TEXT,
    "doneAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BookkeepingChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookkeepingChecklistItem_periodId_key_key" ON "BookkeepingChecklistItem"("periodId", "key");

-- AddForeignKey
ALTER TABLE "BookkeepingProfile" ADD CONSTRAINT "BookkeepingProfile_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookkeepingChecklistItem" ADD CONSTRAINT "BookkeepingChecklistItem_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "BookkeepingPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Existing bookkeeping reports already shared with clients count as approved;
-- staff-only drafts start in DRAFT.
UPDATE "Document" SET "reviewStatus" = CASE WHEN "visibility" = 'PUBLISHED' THEN 'APPROVED' ELSE 'DRAFT' END
WHERE "category" = 'BOOKKEEPING' AND "reportType" IS NOT NULL AND "reviewStatus" IS NULL;

-- Clients who already have bookkeeping months join the Bookkeeping Clients list (monthly).
INSERT INTO "BookkeepingProfile" ("clientId", "updatedAt")
SELECT DISTINCT "clientId", CURRENT_TIMESTAMP FROM "BookkeepingPeriod"
ON CONFLICT DO NOTHING;
