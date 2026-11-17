-- Whose bank or card account is this? Each registered account carries how its ownership was
-- established. Additive only; existing accounts start as NOT_CHECKED (nothing is blocked by default).
ALTER TABLE "BookkeepingAccount" ADD COLUMN "ownershipStatus" TEXT NOT NULL DEFAULT 'NOT_CHECKED';
ALTER TABLE "BookkeepingAccount" ADD COLUMN "ownershipNote" TEXT;
ALTER TABLE "BookkeepingAccount" ADD COLUMN "ownershipCheckedAt" TIMESTAMP(3);
