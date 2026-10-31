-- Questions on bookkeeping months (status, response due date), revised completion estimates, and an optional review day. Adds columns and one table; existing data unchanged.
-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "askedById" TEXT,
ADD COLUMN     "questionStatus" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" TEXT,
ADD COLUMN     "responseDueAt" TIMESTAMP(3);


-- CreateTable
CREATE TABLE "PeriodTargetRevision" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "targetOn" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PeriodTargetRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PeriodTargetRevision_periodId_idx" ON "PeriodTargetRevision"("periodId");

-- AddForeignKey
ALTER TABLE "PeriodTargetRevision" ADD CONSTRAINT "PeriodTargetRevision_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "BookkeepingPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookkeepingProfile" ADD COLUMN     "reviewDueDay" INTEGER;
