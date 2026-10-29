-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "docType" TEXT,
ADD COLUMN     "needsReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT;

-- AlterTable
ALTER TABLE "StaffAlert" ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'SMS',
ADD COLUMN     "documentIds" TEXT[];

-- AlterTable
ALTER TABLE "StaffAlertSettings" ADD COLUMN     "email" TEXT NOT NULL DEFAULT 'info@tturnerassociates.com',
ADD COLUMN     "emailEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ScannerCheck" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eicarResult" TEXT NOT NULL,
    "cleanResult" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "detail" TEXT,
    "runById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScannerCheck_pkey" PRIMARY KEY ("id")
);

