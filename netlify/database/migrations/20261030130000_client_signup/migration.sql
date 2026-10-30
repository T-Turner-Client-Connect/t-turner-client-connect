-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('IN_PROGRESS', 'APPROVED_NEW', 'NEEDS_REVIEW', 'LINKED_EXISTING', 'DECLINED');

-- CreateEnum
CREATE TYPE "ActivationStatus" AS ENUM ('INVITE_SENT', 'ALREADY_ACTIVE', 'NEEDS_STAFF', 'EMAIL_FAILED', 'RESOLVED', 'DISMISSED');

-- DropForeignKey
ALTER TABLE "PortalInvite" DROP CONSTRAINT "PortalInvite_invitedById_fkey";

-- AlterTable
ALTER TABLE "PortalInvite" ALTER COLUMN "invitedById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PortalUser" ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'INVITED';

-- CreateTable
CREATE TABLE "PortalSignup" (
    "id" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "browserHash" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeExpiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sendCount" INTEGER NOT NULL DEFAULT 1,
    "lastSentAt" TIMESTAMP(3) NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "ipHash" TEXT,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalSignup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingApplication" (
    "id" TEXT NOT NULL,
    "portalUserId" TEXT NOT NULL,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "clientType" "ClientType" NOT NULL DEFAULT 'INDIVIDUAL',
    "firstName" TEXT,
    "lastName" TEXT,
    "businessName" TEXT,
    "phone" TEXT,
    "phoneNormalized" TEXT,
    "addressLine1" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "servicesRequested" TEXT[],
    "notes" TEXT,
    "smsService" BOOLEAN NOT NULL DEFAULT false,
    "smsMarketing" BOOLEAN NOT NULL DEFAULT false,
    "emailMarketing" BOOLEAN NOT NULL DEFAULT false,
    "possibleMatchIds" TEXT[],
    "submittedAt" TIMESTAMP(3),
    "clientId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingFile" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "movedDocumentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnboardingFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivationRequest" (
    "id" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "ipHash" TEXT,
    "status" "ActivationStatus" NOT NULL,
    "matchedClientIds" TEXT[],
    "inviteId" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortalSignup_browserHash_key" ON "PortalSignup"("browserHash");

-- CreateIndex
CREATE INDEX "PortalSignup_emailNormalized_idx" ON "PortalSignup"("emailNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingApplication_portalUserId_key" ON "OnboardingApplication"("portalUserId");

-- CreateIndex
CREATE INDEX "OnboardingApplication_status_idx" ON "OnboardingApplication"("status");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingFile_storageKey_key" ON "OnboardingFile"("storageKey");

-- CreateIndex
CREATE INDEX "ActivationRequest_status_idx" ON "ActivationRequest"("status");

-- AddForeignKey
ALTER TABLE "PortalInvite" ADD CONSTRAINT "PortalInvite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingApplication" ADD CONSTRAINT "OnboardingApplication_portalUserId_fkey" FOREIGN KEY ("portalUserId") REFERENCES "PortalUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingFile" ADD CONSTRAINT "OnboardingFile_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "OnboardingApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AlterTable
ALTER TABLE "PortalInvite" ADD COLUMN     "sentByEmail" BOOLEAN NOT NULL DEFAULT false;
