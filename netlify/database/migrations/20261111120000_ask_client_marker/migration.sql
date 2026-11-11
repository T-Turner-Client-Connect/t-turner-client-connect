-- Ask Client items are marked explicitly. Only these wait for Tabitha's client-rollout
-- authorization; the office's existing document requests keep working as before. Additive only.
ALTER TABLE "DocumentRequest" ADD COLUMN "askClient" BOOLEAN NOT NULL DEFAULT false;
