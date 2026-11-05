-- Prepared invitations: staff prepare portal invitations in a draft batch, Tabitha approves each row,
-- and nothing is sent until she turns on the owner switch "Portal invitations authorized" (off by default).
-- Additive only: two new tables and three new IntegrationSettings columns; nothing existing is changed.

-- AlterTable
ALTER TABLE "IntegrationSettings" ADD COLUMN     "portalInvitesAuthorized" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "portalInvitesChangedAt" TIMESTAMP(3),
ADD COLUMN     "portalInvitesChangedById" TEXT;

-- CreateTable
CREATE TABLE "PortalInviteBatch" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "importBatchId" TEXT,
    "createdById" TEXT NOT NULL,
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalInviteBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalInviteBatchRow" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "contactId" TEXT,
    "inviteeName" TEXT NOT NULL,
    "email" TEXT,
    "role" "PortalRole" NOT NULL DEFAULT 'OWNER',
    "permissions" JSONB NOT NULL,
    "sharedEmailConfirmedAt" TIMESTAMP(3),
    "sharedEmailConfirmedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "sendStartedAt" TIMESTAMP(3),
    "result" TEXT,
    "resultDetail" TEXT,
    "resultAt" TIMESTAMP(3),
    "portalInviteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalInviteBatchRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortalInviteBatch_createdAt_idx" ON "PortalInviteBatch"("createdAt");

-- CreateIndex
CREATE INDEX "PortalInviteBatchRow_clientId_idx" ON "PortalInviteBatchRow"("clientId");

-- CreateIndex
CREATE INDEX "PortalInviteBatchRow_portalInviteId_idx" ON "PortalInviteBatchRow"("portalInviteId");

-- CreateIndex
CREATE UNIQUE INDEX "PortalInviteBatchRow_batchId_clientId_key" ON "PortalInviteBatchRow"("batchId", "clientId");

-- AddForeignKey
ALTER TABLE "PortalInviteBatch" ADD CONSTRAINT "PortalInviteBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalInviteBatchRow" ADD CONSTRAINT "PortalInviteBatchRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PortalInviteBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalInviteBatchRow" ADD CONSTRAINT "PortalInviteBatchRow_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

