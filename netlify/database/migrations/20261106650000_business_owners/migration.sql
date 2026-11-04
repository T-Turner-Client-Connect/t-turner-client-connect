-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DocumentCategory" ADD VALUE 'OWNER_K1';
ALTER TYPE "DocumentCategory" ADD VALUE 'PAYROLL';

-- AlterEnum
ALTER TYPE "ServiceType" ADD VALUE 'K1_PREPARATION';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "privateToPortalUserId" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "businessOwnerId" TEXT;

-- AlterTable
ALTER TABLE "PortalAccess" ADD COLUMN     "canApprovePayroll" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canUploadPayroll" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "canViewDocuments" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "canViewPayroll" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "PortalInvite" ADD COLUMN     "businessOwnerId" TEXT,
ADD COLUMN     "permissions" JSONB;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "ownerPermissionsAccess" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ownerPermissionsGrantedAt" TIMESTAMP(3),
ADD COLUMN     "ownerPermissionsGrantedBy" TEXT;


-- CreateTable
CREATE TABLE "BusinessOwner" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "ownershipBps" INTEGER,
    "title" TEXT,
    "receivesK1" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "portalUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessOwner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerK1Grant" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "viewerOwnerId" TEXT NOT NULL,
    "holderOwnerId" TEXT NOT NULL,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "OwnerK1Grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JointFilingYear" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "needed" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "setById" TEXT,
    "setByPortalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JointFilingYear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalTaxRequest" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "portalUserId" TEXT NOT NULL,
    "businessOwnerId" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "personalClientId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonalTaxRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessOwner_contactId_key" ON "BusinessOwner"("contactId");

-- CreateIndex
CREATE INDEX "BusinessOwner_clientId_idx" ON "BusinessOwner"("clientId");

-- CreateIndex
CREATE INDEX "BusinessOwner_portalUserId_idx" ON "BusinessOwner"("portalUserId");

-- CreateIndex
CREATE INDEX "OwnerK1Grant_clientId_idx" ON "OwnerK1Grant"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerK1Grant_viewerOwnerId_holderOwnerId_key" ON "OwnerK1Grant"("viewerOwnerId", "holderOwnerId");

-- CreateIndex
CREATE UNIQUE INDEX "JointFilingYear_clientId_taxYear_key" ON "JointFilingYear"("clientId", "taxYear");

-- CreateIndex
CREATE INDEX "PersonalTaxRequest_status_idx" ON "PersonalTaxRequest"("status");

-- CreateIndex
CREATE INDEX "PersonalTaxRequest_clientId_idx" ON "PersonalTaxRequest"("clientId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_businessOwnerId_fkey" FOREIGN KEY ("businessOwnerId") REFERENCES "BusinessOwner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessOwner" ADD CONSTRAINT "BusinessOwner_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessOwner" ADD CONSTRAINT "BusinessOwner_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessOwner" ADD CONSTRAINT "BusinessOwner_portalUserId_fkey" FOREIGN KEY ("portalUserId") REFERENCES "PortalUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerK1Grant" ADD CONSTRAINT "OwnerK1Grant_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerK1Grant" ADD CONSTRAINT "OwnerK1Grant_viewerOwnerId_fkey" FOREIGN KEY ("viewerOwnerId") REFERENCES "BusinessOwner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerK1Grant" ADD CONSTRAINT "OwnerK1Grant_holderOwnerId_fkey" FOREIGN KEY ("holderOwnerId") REFERENCES "BusinessOwner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JointFilingYear" ADD CONSTRAINT "JointFilingYear_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalTaxRequest" ADD CONSTRAINT "PersonalTaxRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalTaxRequest" ADD CONSTRAINT "PersonalTaxRequest_portalUserId_fkey" FOREIGN KEY ("portalUserId") REFERENCES "PortalUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

