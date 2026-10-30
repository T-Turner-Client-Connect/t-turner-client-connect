-- AlterTable
ALTER TABLE "PortalInvite" ADD COLUMN     "emailDeliveredAt" TIMESTAMP(3),
ADD COLUMN     "emailError" TEXT,
ADD COLUMN     "emailProviderId" TEXT,
ADD COLUMN     "emailSentAt" TIMESTAMP(3),
ADD COLUMN     "emailStatus" TEXT,
ADD COLUMN     "emailTo" TEXT;


-- CreateIndex
CREATE UNIQUE INDEX "PortalInvite_emailProviderId_key" ON "PortalInvite"("emailProviderId");

