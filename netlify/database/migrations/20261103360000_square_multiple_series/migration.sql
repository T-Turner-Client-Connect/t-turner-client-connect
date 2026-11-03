-- A client can be on more than one Square recurring series (never twice on the same one).
-- Existing links are unchanged: they were already unique per client, so they are unique per series too.
DROP INDEX "SquareBillingMember_clientId_key";
CREATE INDEX "SquareBillingMember_clientId_idx" ON "SquareBillingMember"("clientId");
CREATE UNIQUE INDEX "SquareBillingMember_arrangementId_clientId_key" ON "SquareBillingMember"("arrangementId", "clientId");
