-- Business owners' own personal tax documents and identity documents (additive only).

-- AlterEnum
ALTER TYPE "DocumentCategory" ADD VALUE 'OWNER_PERSONAL';

-- AlterTable
ALTER TABLE "DocumentRequest" ADD COLUMN "businessOwnerId" TEXT;

-- AlterTable
ALTER TABLE "IdentityPerson" ADD COLUMN "businessOwnerId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "IdentityPerson_businessOwnerId_key" ON "IdentityPerson"("businessOwnerId");

-- AddForeignKey
ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_businessOwnerId_fkey" FOREIGN KEY ("businessOwnerId") REFERENCES "BusinessOwner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityPerson" ADD CONSTRAINT "IdentityPerson_businessOwnerId_fkey" FOREIGN KEY ("businessOwnerId") REFERENCES "BusinessOwner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
