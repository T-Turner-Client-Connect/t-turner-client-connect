-- Tabitha's switch: Coetha posts routine bookkeeping herself (on by default, her decision).
-- Additive columns only.
ALTER TABLE "IntegrationSettings" ADD COLUMN "coethaAutoPost" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "IntegrationSettings" ADD COLUMN "coethaAutoPostChangedById" TEXT;
ALTER TABLE "IntegrationSettings" ADD COLUMN "coethaAutoPostChangedAt" TIMESTAMP(3);
