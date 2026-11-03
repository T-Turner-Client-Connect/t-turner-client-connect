-- Owner switch for staff texting clients (off until Tabitha turns it on). Additive only.
ALTER TABLE "StaffAlertSettings" ADD COLUMN "clientTextingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StaffAlertSettings" ADD COLUMN "clientTextingChangedAt" TIMESTAMP(3);
ALTER TABLE "StaffAlertSettings" ADD COLUMN "clientTextingChangedBy" TEXT;
