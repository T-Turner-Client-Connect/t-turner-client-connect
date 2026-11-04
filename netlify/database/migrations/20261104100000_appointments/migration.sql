-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'RESCHEDULE_REQUESTED', 'PROPOSED', 'DECLINED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "bookedByPortalUserId" TEXT,
ADD COLUMN     "bookingInfo" JSONB,
ADD COLUMN     "clientNotes" TEXT,
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "durationMin" INTEGER,
ADD COLUMN     "endsAt" TIMESTAMP(3),
ADD COLUMN     "meetingType" TEXT,
ADD COLUMN     "pendingBy" TEXT,
ADD COLUMN     "pendingEndsAt" TIMESTAMP(3),
ADD COLUMN     "pendingStaffId" TEXT,
ADD COLUMN     "pendingStartsAt" TIMESTAMP(3),
ADD COLUMN     "services" TEXT[],
ADD COLUMN     "smsOptIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'STAFF',
ADD COLUMN     "staffNotes" TEXT,
ADD COLUMN     "status" "AppointmentStatus" NOT NULL DEFAULT 'CONFIRMED',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "AppointmentSlotClaim" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "blockStart" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CURRENT',

    CONSTRAINT "AppointmentSlotClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentEvent" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentNotice" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "to" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "statusDetail" TEXT,
    "providerSid" TEXT,
    "deliveryStatus" TEXT,
    "notBefore" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "weekdays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "openTime" TEXT NOT NULL DEFAULT '09:00',
    "closeTime" TEXT NOT NULL DEFAULT '17:00',
    "slotStepMin" INTEGER NOT NULL DEFAULT 30,
    "maxPerDay" INTEGER NOT NULL DEFAULT 6,
    "minNoticeHours" INTEGER NOT NULL DEFAULT 24,
    "cancelCutoffHours" INTEGER NOT NULL DEFAULT 24,
    "rescheduleNeedsApproval" BOOLEAN NOT NULL DEFAULT true,
    "requireApproval" BOOLEAN NOT NULL DEFAULT true,
    "meetingTypes" TEXT[] DEFAULT ARRAY['IN_OFFICE', 'PHONE', 'VIRTUAL']::TEXT[],
    "alertEmail" TEXT NOT NULL DEFAULT 'info@tturnerassociates.com',
    "alertPhone" TEXT NOT NULL DEFAULT '+12054201825',
    "remind24h" BOOLEAN NOT NULL DEFAULT true,
    "remind2h" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentMonth" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "weekdays" INTEGER[],
    "openTime" TEXT NOT NULL,
    "closeTime" TEXT NOT NULL,
    "maxPerDay" INTEGER NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentMonth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentDateRule" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "label" TEXT,
    "startTime" TEXT,
    "endTime" TEXT,
    "staffId" TEXT,
    "maxPerDay" INTEGER,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentDateRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentStaff" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "weekdays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "startTime" TEXT,
    "endTime" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentStaff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppointmentSlotClaim_appointmentId_idx" ON "AppointmentSlotClaim"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentSlotClaim_staffId_blockStart_key" ON "AppointmentSlotClaim"("staffId", "blockStart");

-- CreateIndex
CREATE INDEX "AppointmentEvent_appointmentId_createdAt_idx" ON "AppointmentEvent"("appointmentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentNotice_providerSid_key" ON "AppointmentNotice"("providerSid");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentNotice_idempotencyKey_key" ON "AppointmentNotice"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AppointmentNotice_status_notBefore_idx" ON "AppointmentNotice"("status", "notBefore");

-- CreateIndex
CREATE INDEX "AppointmentNotice_appointmentId_createdAt_idx" ON "AppointmentNotice"("appointmentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentMonth_year_month_key" ON "AppointmentMonth"("year", "month");

-- CreateIndex
CREATE INDEX "AppointmentDateRule_date_idx" ON "AppointmentDateRule"("date");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentStaff_userId_key" ON "AppointmentStaff"("userId");

-- CreateIndex
CREATE INDEX "Appointment_clientId_startsAt_idx" ON "Appointment"("clientId", "startsAt");

-- CreateIndex
CREATE INDEX "Appointment_status_startsAt_idx" ON "Appointment"("status", "startsAt");

-- AddForeignKey
ALTER TABLE "AppointmentSlotClaim" ADD CONSTRAINT "AppointmentSlotClaim_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentEvent" ADD CONSTRAINT "AppointmentEvent_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentNotice" ADD CONSTRAINT "AppointmentNotice_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Existing appointments: cancelled ones get the new status; the rest get a one-hour end time.
UPDATE "Appointment" SET "status" = 'CANCELLED' WHERE "cancelledAt" IS NOT NULL;
UPDATE "Appointment" SET "endsAt" = "startsAt" + interval '60 minutes', "durationMin" = 60 WHERE "endsAt" IS NULL;
