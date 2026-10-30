-- AlterTable
ALTER TABLE "Invite" ADD COLUMN     "grantBillingAccess" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "grantIdentityAccessAll" BOOLEAN NOT NULL DEFAULT false;


