-- Bulk tax-return intake queue (staff confirm before filing). Adds one table; existing data unchanged.

-- CreateTable
CREATE TABLE "ReturnIntake" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "suggestedClientId" TEXT,
    "matchReason" TEXT,
    "suggestedYear" INTEGER,
    "suggestedType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "documentId" TEXT,
    "uploadedById" TEXT NOT NULL,
    "filedById" TEXT,
    "filedAt" TIMESTAMP(3),
    "discardedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnIntake_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReturnIntake_fileId_key" ON "ReturnIntake"("fileId");

-- CreateIndex
CREATE INDEX "ReturnIntake_status_idx" ON "ReturnIntake"("status");

