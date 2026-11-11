-- IRS Identity Protection PINs: one per person per year, encrypted. Additive only.
ALTER TABLE "IdentityPerson" ADD COLUMN "hasIpPin" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "IdentityPin" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "personId" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "pinEnc" TEXT NOT NULL,
  "enteredByPortalId" TEXT,
  "enteredByStaffId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IdentityPin_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IdentityPin_personId_year_key" ON "IdentityPin"("personId", "year");
CREATE INDEX "IdentityPin_clientId_idx" ON "IdentityPin"("clientId");
ALTER TABLE "IdentityPin" ADD CONSTRAINT "IdentityPin_personId_fkey" FOREIGN KEY ("personId") REFERENCES "IdentityPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
