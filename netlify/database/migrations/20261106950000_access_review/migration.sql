-- Owner's Office -> Access review: quarterly access reviews (staff snapshot + vendor checklist) and
-- staff offboarding records with a checklist of owner tasks for systems outside Client Connect.
-- Additive only: three new tables; nothing existing is changed.

-- CreateTable
CREATE TABLE "AccessReview" (
    "id" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "reviewerName" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary" TEXT NOT NULL,
    "findings" TEXT,
    "staffSnapshot" JSONB NOT NULL,
    "vendorAnswers" JSONB NOT NULL,
    "changes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffOffboarding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "userRole" "Role" NOT NULL,
    "reason" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "offboardedById" TEXT NOT NULL,
    "offboardedByName" TEXT NOT NULL,
    "removedGrants" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sessionsEnded" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffOffboarding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffOffboardingItem" (
    "id" TEXT NOT NULL,
    "offboardingId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "taskId" TEXT,

    CONSTRAINT "StaffOffboardingItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccessReview_completedAt_idx" ON "AccessReview"("completedAt");

-- CreateIndex
CREATE INDEX "StaffOffboarding_userId_idx" ON "StaffOffboarding"("userId");

-- CreateIndex
CREATE INDEX "StaffOffboarding_createdAt_idx" ON "StaffOffboarding"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StaffOffboardingItem_taskId_key" ON "StaffOffboardingItem"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffOffboardingItem_offboardingId_key_key" ON "StaffOffboardingItem"("offboardingId", "key");

-- AddForeignKey
ALTER TABLE "StaffOffboardingItem" ADD CONSTRAINT "StaffOffboardingItem_offboardingId_fkey" FOREIGN KEY ("offboardingId") REFERENCES "StaffOffboarding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffOffboardingItem" ADD CONSTRAINT "StaffOffboardingItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

