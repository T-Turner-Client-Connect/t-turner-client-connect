-- Owner's Office -> Access review reminders (upcoming task, due email, dashboard banner).
-- Additive only: two new Task columns with safe defaults and one new table. No column or row is
-- dropped; the only data change marks any already-open access-review reminder as owner-only so it
-- leaves other staff members' Tasks lists as soon as this deploys.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "ownerOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reminderKey" TEXT;

-- CreateTable
CREATE TABLE "OwnerReminderLog" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "providerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnerReminderLog_key_key" ON "OwnerReminderLog"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Task_reminderKey_key" ON "Task"("reminderKey");

-- Existing open reminder (created before this change) becomes owner-only.
UPDATE "Task" SET "ownerOnly" = true WHERE "title" = 'Quarterly access review due' AND "status" = 'OPEN';
