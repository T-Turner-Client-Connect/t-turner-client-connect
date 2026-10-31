-- Nonprofit annual filing setup (form, basis, reminders). Adds one table; existing data unchanged.

-- CreateTable
CREATE TABLE "NonprofitProfile" (
    "clientId" TEXT NOT NULL,
    "formType" TEXT,
    "otherForm" TEXT,
    "formBasis" TEXT,
    "reminderDays" INTEGER[] DEFAULT ARRAY[60, 30, 7]::INTEGER[],
    "notifyClient" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NonprofitProfile_pkey" PRIMARY KEY ("clientId")
);

-- AddForeignKey
ALTER TABLE "NonprofitProfile" ADD CONSTRAINT "NonprofitProfile_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

