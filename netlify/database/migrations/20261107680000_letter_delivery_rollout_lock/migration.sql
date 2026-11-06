-- Client Letters: honest delivery tracking (filed, portal posted, email delivered / bounced /
-- complained from Resend events, follow-up flag, first viewed by the client's own login, optional
-- acknowledgment) and the owner's "Client rollout authorized" safety lock (off by default).
-- Additive only: new nullable columns and indexes.

-- AlterTable
ALTER TABLE "ClientLetter" ADD COLUMN     "acknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "acknowledgedByPortalUserId" TEXT,
ADD COLUMN     "emailBounceReason" TEXT,
ADD COLUMN     "emailBouncedAt" TIMESTAMP(3),
ADD COLUMN     "emailComplainedAt" TIMESTAMP(3),
ADD COLUMN     "emailDeliveredAt" TIMESTAMP(3),
ADD COLUMN     "filedAt" TIMESTAMP(3),
ADD COLUMN     "firstViewedAt" TIMESTAMP(3),
ADD COLUMN     "firstViewedByPortalUserId" TEXT,
ADD COLUMN     "firstViewedVia" TEXT,
ADD COLUMN     "followUpClearedAt" TIMESTAMP(3),
ADD COLUMN     "followUpFlaggedAt" TIMESTAMP(3),
ADD COLUMN     "followUpReason" TEXT,
ADD COLUMN     "portalPostedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "IntegrationSettings" ADD COLUMN     "clientRolloutAuthorized" BOOLEAN,
ADD COLUMN     "clientRolloutChangedAt" TIMESTAMP(3),
ADD COLUMN     "clientRolloutChangedById" TEXT;


-- CreateIndex
CREATE INDEX "ClientLetter_emailProviderId_idx" ON "ClientLetter"("emailProviderId");

-- CreateIndex
CREATE INDEX "ClientLetter_messageId_idx" ON "ClientLetter"("messageId");

-- CreateIndex
CREATE INDEX "ClientLetter_documentId_idx" ON "ClientLetter"("documentId");

