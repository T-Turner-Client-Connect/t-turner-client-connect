-- Tabitha: automatic posting is OFF by default and turned on only by her. New rows default to
-- off, and the switch is set off unless she has already changed it herself. Additive.
ALTER TABLE "IntegrationSettings" ALTER COLUMN "coethaAutoPost" SET DEFAULT false;
UPDATE "IntegrationSettings" SET "coethaAutoPost" = false WHERE "coethaAutoPostChangedAt" IS NULL;
