-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "lastScanAt" TIMESTAMP(3),
ADD COLUMN     "lastScanError" TEXT,
ADD COLUMN     "scanAttempts" INTEGER NOT NULL DEFAULT 0;


-- CreateTable
CREATE TABLE "SystemHeartbeat" (
    "key" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "detail" JSONB,

    CONSTRAINT "SystemHeartbeat_pkey" PRIMARY KEY ("key")
);

