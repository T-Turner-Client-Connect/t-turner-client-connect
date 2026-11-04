-- CreateEnum
CREATE TYPE "CampaignMessageStatus" AS ENUM ('SKIPPED', 'SENDING', 'PROVIDER_ACCEPTED', 'FAILED');

-- CreateEnum
CREATE TYPE "CommPrefCategory" AS ENUM ('PROMO_EMAIL', 'PROMO_SMS', 'GENERAL_UPDATES');

-- AlterEnum
ALTER TYPE "CampaignPurpose" ADD VALUE 'GENERAL_UPDATE';

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "sentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CampaignMessage" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "address" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "contactId" TEXT,
    "status" "CampaignMessageStatus" NOT NULL,
    "skipReason" TEXT,
    "providerId" TEXT,
    "errorDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationPreference" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "contactId" TEXT,
    "personKey" TEXT NOT NULL,
    "generalUpdates" BOOLEAN NOT NULL DEFAULT true,
    "updatedSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunicationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationPreferenceChange" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "contactId" TEXT,
    "category" "CommPrefCategory" NOT NULL,
    "subscribed" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "address" TEXT,
    "portalUserId" TEXT,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationPreferenceChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignMessage_campaignId_status_idx" ON "CampaignMessage"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMessage_campaignId_channel_address_key" ON "CampaignMessage"("campaignId", "channel", "address");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationPreference_clientId_personKey_key" ON "CommunicationPreference"("clientId", "personKey");

-- CreateIndex
CREATE INDEX "CommunicationPreferenceChange_clientId_createdAt_idx" ON "CommunicationPreferenceChange"("clientId", "createdAt");

-- AddForeignKey
ALTER TABLE "CampaignMessage" ADD CONSTRAINT "CampaignMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationPreference" ADD CONSTRAINT "CommunicationPreference_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationPreference" ADD CONSTRAINT "CommunicationPreference_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationPreferenceChange" ADD CONSTRAINT "CommunicationPreferenceChange_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

