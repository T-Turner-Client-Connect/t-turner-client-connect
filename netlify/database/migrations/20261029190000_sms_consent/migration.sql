-- CreateEnum
CREATE TYPE "SmsConsentCategory" AS ENUM ('SERVICE', 'MARKETING');

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "deliveryStatus" TEXT,
ADD COLUMN     "providerSid" TEXT;


-- CreateTable
CREATE TABLE "SmsConsentSubmission" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phoneNormalized" TEXT NOT NULL,
    "serviceOptIn" BOOLEAN NOT NULL,
    "marketingOptIn" BOOLEAN NOT NULL,
    "consentVersion" TEXT NOT NULL,
    "serviceText" TEXT NOT NULL,
    "marketingText" TEXT NOT NULL,
    "sourcePage" TEXT NOT NULL,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "matchedClientIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsConsentSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsConsentEvent" (
    "id" TEXT NOT NULL,
    "phoneNormalized" TEXT NOT NULL,
    "category" "SmsConsentCategory" NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "source" TEXT NOT NULL,
    "sourcePage" TEXT,
    "consentVersion" TEXT,
    "consentText" TEXT,
    "submissionId" TEXT,
    "inboundSmsId" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsConsentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundSms" (
    "id" TEXT NOT NULL,
    "providerSid" TEXT NOT NULL,
    "fromNormalized" TEXT NOT NULL,
    "toNumber" TEXT,
    "body" TEXT NOT NULL,
    "keyword" TEXT,
    "matchedClientId" TEXT,
    "conversationId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundSms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SmsConsentSubmission_phoneNormalized_createdAt_idx" ON "SmsConsentSubmission"("phoneNormalized", "createdAt");

-- CreateIndex
CREATE INDEX "SmsConsentSubmission_createdAt_idx" ON "SmsConsentSubmission"("createdAt");

-- CreateIndex
CREATE INDEX "SmsConsentEvent_phoneNormalized_category_createdAt_idx" ON "SmsConsentEvent"("phoneNormalized", "category", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundSms_providerSid_key" ON "InboundSms"("providerSid");

-- CreateIndex
CREATE INDEX "InboundSms_fromNormalized_receivedAt_idx" ON "InboundSms"("fromNormalized", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_providerSid_key" ON "Notification"("providerSid");

