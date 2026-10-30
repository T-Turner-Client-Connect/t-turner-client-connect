-- CreateEnum
CREATE TYPE "StaffAlertStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "StaffAlertSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "phone" TEXT NOT NULL DEFAULT '+12056595448',
    "windowStart" TEXT NOT NULL DEFAULT '08:00',
    "windowEnd" TEXT NOT NULL DEFAULT '17:00',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffAlertSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffAlert" (
    "id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "conversationIds" TEXT[],
    "status" "StaffAlertStatus" NOT NULL DEFAULT 'PENDING',
    "notBefore" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "providerSid" TEXT,
    "deliveryStatus" TEXT,
    "statusDetail" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffAlert_providerSid_key" ON "StaffAlert"("providerSid");

-- CreateIndex
CREATE INDEX "StaffAlert_status_notBefore_idx" ON "StaffAlert"("status", "notBefore");

