-- Managed Business Client access (foundational security).
-- Every existing and new client starts as a Regular Tax Client (businessAccess = OFF).
-- Nobody is converted by this migration: client type, tax return type, services and
-- registration answers never grant business access. Only the owner can approve it.
-- New portal logins no longer get the per-login business view by default; existing
-- per-login flags stay as they are but have no effect while the business is OFF.

-- CreateEnum
CREATE TYPE "BusinessAccess" AS ENUM ('OFF', 'ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "BusinessAccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "businessAccess" "BusinessAccess" NOT NULL DEFAULT 'OFF',
ADD COLUMN     "businessAccessChangedAt" TIMESTAMP(3),
ADD COLUMN     "businessAccessChangedBy" TEXT;

-- AlterTable
ALTER TABLE "PortalAccess" ALTER COLUMN "canViewBookkeeping" SET DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "businessConversionAccess" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "businessConversionGrantedAt" TIMESTAMP(3),
ADD COLUMN     "businessConversionGrantedBy" TEXT;

-- CreateTable
CREATE TABLE "BusinessAccessRequest" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "services" TEXT[],
    "reason" TEXT NOT NULL,
    "status" "BusinessAccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessAccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessAccessEvent" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "fromStatus" "BusinessAccess",
    "toStatus" "BusinessAccess",
    "requestId" TEXT,
    "targetUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessAccessEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessAccessRequest_status_createdAt_idx" ON "BusinessAccessRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "BusinessAccessRequest_clientId_createdAt_idx" ON "BusinessAccessRequest"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "BusinessAccessEvent_clientId_createdAt_idx" ON "BusinessAccessEvent"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "BusinessAccessEvent_createdAt_idx" ON "BusinessAccessEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "BusinessAccessRequest" ADD CONSTRAINT "BusinessAccessRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessAccessRequest" ADD CONSTRAINT "BusinessAccessRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessAccessRequest" ADD CONSTRAINT "BusinessAccessRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessAccessEvent" ADD CONSTRAINT "BusinessAccessEvent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessAccessEvent" ADD CONSTRAINT "BusinessAccessEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

