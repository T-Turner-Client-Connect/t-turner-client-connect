-- Document security: encrypt all client documents, 30-day recoverable deletion,
-- independent encrypted nightly backups, tested restore.
-- Additive only: new tables and nullable columns. No drops, no data changes. Nothing here
-- encrypts, moves or deletes a file: the encryption job runs only when the owner starts it.
-- Merge order: after #121 (20261107640000) and before #114 (20261107700000).

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "keyVersion" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "purgeAfter" TIMESTAMP(3),
ADD COLUMN     "purgedAt" TIMESTAMP(3),
ADD COLUMN     "purgedById" TEXT,
ADD COLUMN     "restoredAt" TIMESTAMP(3),
ADD COLUMN     "restoredById" TEXT;

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "receiptEncrypted" BOOLEAN;

-- AlterTable
ALTER TABLE "OnboardingFile" ADD COLUMN     "encrypted" BOOLEAN;

-- AlterTable
ALTER TABLE "IntegrationSettings" ADD COLUMN     "keyEscrowConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "keyEscrowConfirmedById" TEXT,
ADD COLUMN     "keyEscrowNote" TEXT,
ADD COLUMN     "nightlyBackupsChangedAt" TIMESTAMP(3),
ADD COLUMN     "nightlyBackupsChangedById" TEXT,
ADD COLUMN     "nightlyBackupsEnabled" BOOLEAN;

-- CreateTable
CREATE TABLE "FileEncryptionJob" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'ENCRYPT',
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "groupOrder" TEXT[],
    "startedById" TEXT,
    "source" TEXT NOT NULL DEFAULT 'PAGE',
    "totalFiles" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "doneFiles" INTEGER NOT NULL DEFAULT 0,
    "doneBytes" BIGINT NOT NULL DEFAULT 0,
    "failedFiles" INTEGER NOT NULL DEFAULT 0,
    "batches" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastBatchAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "FileEncryptionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileEncryptionItem" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "oldKey" TEXT NOT NULL,
    "newKey" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileEncryptionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingOriginalRemoval" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "originalKey" TEXT NOT NULL,
    "replacementKey" TEXT NOT NULL,
    "sha256" TEXT,
    "reason" TEXT NOT NULL,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,

    CONSTRAINT "PendingOriginalRemoval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'NIGHTLY',
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "phase" TEXT NOT NULL DEFAULT 'DB',
    "cursor" JSONB,
    "backupDate" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "steps" INTEGER NOT NULL DEFAULT 0,
    "tables" INTEGER NOT NULL DEFAULT 0,
    "rows" BIGINT NOT NULL DEFAULT 0,
    "files" INTEGER NOT NULL DEFAULT 0,
    "filesUploaded" INTEGER NOT NULL DEFAULT 0,
    "bytesUploaded" BIGINT NOT NULL DEFAULT 0,
    "manifestKey" TEXT,
    "manifestSha256" TEXT,
    "lastMigration" TEXT,
    "retention" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "prunedAt" TIMESTAMP(3),
    "error" TEXT,
    "alertedAt" TIMESTAMP(3),

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupFileIndex" (
    "storageKey" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "storedSha256" TEXT NOT NULL,
    "objectSha256" TEXT NOT NULL,
    "plainSha256" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "group" TEXT,
    "firstRunId" TEXT NOT NULL,
    "firstRunAt" TIMESTAMP(3) NOT NULL,
    "goneAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "prunedAt" TIMESTAMP(3),

    CONSTRAINT "BackupFileIndex_pkey" PRIMARY KEY ("storageKey")
);

-- CreateTable
CREATE TABLE "RestoreTest" (
    "id" TEXT NOT NULL,
    "backupRunId" TEXT,
    "manifestKey" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "result" JSONB,
    "error" TEXT,

    CONSTRAINT "RestoreTest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileEncryptionItem_status_idx" ON "FileEncryptionItem"("status");

-- CreateIndex
CREATE UNIQUE INDEX "FileEncryptionItem_jobId_sourceType_sourceId_key" ON "FileEncryptionItem"("jobId", "sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingOriginalRemoval_originalKey_key" ON "PendingOriginalRemoval"("originalKey");

-- CreateIndex
CREATE INDEX "PendingOriginalRemoval_removedAt_createdAt_idx" ON "PendingOriginalRemoval"("removedAt", "createdAt");

-- CreateIndex
CREATE INDEX "BackupRun_status_startedAt_idx" ON "BackupRun"("status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BackupFileIndex_objectKey_key" ON "BackupFileIndex"("objectKey");

-- CreateIndex
CREATE INDEX "BackupFileIndex_goneAt_idx" ON "BackupFileIndex"("goneAt");

-- CreateIndex
CREATE INDEX "RestoreTest_status_startedAt_idx" ON "RestoreTest"("status", "startedAt");

-- AddForeignKey
ALTER TABLE "FileEncryptionItem" ADD CONSTRAINT "FileEncryptionItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FileEncryptionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
