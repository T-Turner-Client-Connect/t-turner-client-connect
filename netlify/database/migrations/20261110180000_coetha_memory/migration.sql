-- Coetha's memory for each business: Tabitha's decisions, standing instructions and holds.
-- Additive: a new table only.
CREATE TABLE "CoethaMemory" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,
    CONSTRAINT "CoethaMemory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CoethaMemory_kind_check" CHECK ("kind" IN ('DECISION', 'INSTRUCTION', 'HOLD'))
);
CREATE INDEX "CoethaMemory_clientId_removedAt_idx" ON "CoethaMemory"("clientId", "removedAt");
ALTER TABLE "CoethaMemory" ADD CONSTRAINT "CoethaMemory_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "LedgerBook"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;
