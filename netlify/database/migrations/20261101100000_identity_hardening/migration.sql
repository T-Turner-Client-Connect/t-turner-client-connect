-- AlterTable
ALTER TABLE "IdentityDocument" ADD COLUMN     "verificationTaskId" TEXT;

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "encrypted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "identityAccessAll" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "identityAccessGrantedAt" TIMESTAMP(3),
ADD COLUMN     "identityAccessGrantedBy" TEXT;


