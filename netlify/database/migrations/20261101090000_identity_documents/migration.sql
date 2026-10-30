-- AlterEnum
ALTER TYPE "DocumentCategory" ADD VALUE 'IDENTITY';

-- AlterTable
ALTER TABLE "PortalAccess" ADD COLUMN     "canViewIdentity" BOOLEAN NOT NULL DEFAULT false;


-- CreateTable
CREATE TABLE "IdentityPerson" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityPerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityDocument" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "expiresOn" TEXT,
    "replacementReason" TEXT,
    "last4" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "rejectedReason" TEXT,
    "replacedAt" TIMESTAMP(3),
    "uploadedByPortalId" TEXT,
    "uploadedByStaffId" TEXT,
    "remindersSent" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdentityPerson_clientId_idx" ON "IdentityPerson"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityDocument_documentId_key" ON "IdentityDocument"("documentId");

-- CreateIndex
CREATE INDEX "IdentityDocument_clientId_personId_type_idx" ON "IdentityDocument"("clientId", "personId", "type");

-- CreateIndex
CREATE INDEX "IdentityDocument_status_type_idx" ON "IdentityDocument"("status", "type");

-- AddForeignKey
ALTER TABLE "IdentityPerson" ADD CONSTRAINT "IdentityPerson_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityDocument" ADD CONSTRAINT "IdentityDocument_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityDocument" ADD CONSTRAINT "IdentityDocument_personId_fkey" FOREIGN KEY ("personId") REFERENCES "IdentityPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Account owners can see identity documents; other authorized contacts only when granted.
UPDATE "PortalAccess" SET "canViewIdentity" = true WHERE "role" = 'OWNER';
