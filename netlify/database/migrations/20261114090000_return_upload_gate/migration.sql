-- Tax return upload gate: held (unverified) returns, reviewer-verified matches, and confirmed
-- alternate names. New tables only; nothing existing changes.
CREATE TABLE "ReturnUploadHold" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "filingType" TEXT NOT NULL,
    "returnType" TEXT,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "reasons" JSONB NOT NULL,
    "readYear" INTEGER,
    "readName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "uploadedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReturnUploadHold_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReturnUploadHold_clientId_status_idx" ON "ReturnUploadHold"("clientId", "status");
CREATE INDEX "ReturnUploadHold_status_expiresAt_idx" ON "ReturnUploadHold"("status", "expiresAt");

CREATE TABLE "ReturnVerification" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "filingType" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "holdId" TEXT,
    "verifiedById" TEXT NOT NULL,
    "nameChange" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReturnVerification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReturnVerification_clientId_taxYear_jurisdiction_filingType_sha256_key" ON "ReturnVerification"("clientId", "taxYear", "jurisdiction", "filingType", "sha256");

CREATE TABLE "ClientNameAlias" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "first" TEXT NOT NULL,
    "last" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientNameAlias_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ClientNameAlias_clientId_idx" ON "ClientNameAlias"("clientId");
