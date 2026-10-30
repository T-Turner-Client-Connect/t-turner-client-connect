-- Owners with several businesses: link a Personal client record to each business.
CREATE TABLE "ClientRelationship" (
    "id" TEXT NOT NULL,
    "personClientId" TEXT NOT NULL,
    "businessClientId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OWNER',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientRelationship_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ClientRelationship_businessClientId_idx" ON "ClientRelationship"("businessClientId");
CREATE UNIQUE INDEX "ClientRelationship_personClientId_businessClientId_key" ON "ClientRelationship"("personClientId", "businessClientId");
ALTER TABLE "ClientRelationship" ADD CONSTRAINT "ClientRelationship_personClientId_fkey" FOREIGN KEY ("personClientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientRelationship" ADD CONSTRAINT "ClientRelationship_businessClientId_fkey" FOREIGN KEY ("businessClientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
