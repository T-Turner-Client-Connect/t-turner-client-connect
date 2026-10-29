-- CreateEnum
CREATE TYPE "InviteEmailStatus" AS ENUM ('NOT_SENT', 'SENDING', 'ACCEPTED', 'DELIVERED', 'FAILED');

-- AlterTable
ALTER TABLE "Invite" ADD COLUMN     "createKey" TEXT,
ADD COLUMN     "emailAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "emailAttemptAt" TIMESTAMP(3),
ADD COLUMN     "emailDeliveredAt" TIMESTAMP(3),
ADD COLUMN     "emailError" TEXT,
ADD COLUMN     "emailFailedAt" TIMESTAMP(3),
ADD COLUMN     "emailProviderId" TEXT,
ADD COLUMN     "emailStatus" "InviteEmailStatus" NOT NULL DEFAULT 'NOT_SENT',
ADD COLUMN     "linkCopiedAt" TIMESTAMP(3),
ADD COLUMN     "replacedById" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Invite_emailProviderId_key" ON "Invite"("emailProviderId");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_createKey_key" ON "Invite"("createKey");

