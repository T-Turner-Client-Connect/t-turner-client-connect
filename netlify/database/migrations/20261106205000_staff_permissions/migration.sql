-- Staff Access & Permissions (Owner's Office → Settings). See src/lib/permissions.ts.

-- CreateTable
CREATE TABLE "StaffPermission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "grantedById" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffPermissionEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromAllowed" BOOLEAN NOT NULL,
    "toAllowed" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffPermissionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffPermission_userId_area_action_key" ON "StaffPermission"("userId", "area", "action");

-- CreateIndex
CREATE INDEX "StaffPermissionEvent_userId_createdAt_idx" ON "StaffPermissionEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "StaffPermissionEvent_createdAt_idx" ON "StaffPermissionEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "StaffPermission" ADD CONSTRAINT "StaffPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Data migration: today's access becomes equivalent grants, so nobody loses access they have.
-- The primary owner gets no rows (she holds everything by definition). Each grant is recorded
-- in the history with actor "system". One statement, no temp tables.
--
--   OwnerAccess BILLING (non-primary, not revoked)  -> billing.view, billing.create, billing.edit,
--                                                     billing.record_payment, receivables.reconcile
--   OwnerAccess FULL (non-primary, not revoked)     -> every Owner's Office action it opened:
--                                                     billing.* (except delete_history),
--                                                     square.integrations, receivables.view/reconcile,
--                                                     revenue.view/create/edit, business_access.*,
--                                                     appointments.*   (never staff.*, never owner-only)
--   User.bookkeepingBillingAccess = true             -> square.view, square.edit
-- ---------------------------------------------------------------------------------------------
WITH "map" (src, area, action) AS (VALUES
  ('BILLING', 'billing', 'view'), ('BILLING', 'billing', 'create'), ('BILLING', 'billing', 'edit'),
  ('BILLING', 'billing', 'record_payment'), ('BILLING', 'receivables', 'reconcile'),
  ('FULL', 'billing', 'view'), ('FULL', 'billing', 'create'), ('FULL', 'billing', 'edit'), ('FULL', 'billing', 'approve'),
  ('FULL', 'billing', 'send'), ('FULL', 'billing', 'record_payment'), ('FULL', 'billing', 'refund'), ('FULL', 'billing', 'void'),
  ('FULL', 'billing', 'adjust'), ('FULL', 'billing', 'settings'),
  ('FULL', 'square', 'integrations'),
  ('FULL', 'receivables', 'view'), ('FULL', 'receivables', 'reconcile'),
  ('FULL', 'revenue', 'view'), ('FULL', 'revenue', 'create'), ('FULL', 'revenue', 'edit'),
  ('FULL', 'business_access', 'view'), ('FULL', 'business_access', 'approve'), ('FULL', 'business_access', 'manage'),
  ('FULL', 'appointments', 'view'), ('FULL', 'appointments', 'approve'), ('FULL', 'appointments', 'manage'),
  ('BOOKKEEPING_BILLING', 'square', 'view'), ('BOOKKEEPING_BILLING', 'square', 'edit')
),
"grants" AS (
  SELECT DISTINCT ON (g."userId", g.area, g.action) g."userId", g.area, g.action, g."grantedById", g.src
  FROM (
    SELECT oa."userId", m.area, m.action, oa."grantedById", 'migration:owner_access_' || lower(oa.scope::text) AS src
    FROM "OwnerAccess" oa JOIN "map" m ON m.src = oa.scope::text
    WHERE oa."isPrimary" = false AND oa."revokedAt" IS NULL
    UNION ALL
    SELECT u.id, m.area, m.action, u."bookkeepingBillingGrantedBy", 'migration:bookkeeping_billing'
    FROM "User" u JOIN "map" m ON m.src = 'BOOKKEEPING_BILLING'
    WHERE u."bookkeepingBillingAccess" = true
  ) g
  WHERE NOT EXISTS (SELECT 1 FROM "OwnerAccess" p WHERE p."userId" = g."userId" AND p."isPrimary" = true)
  ORDER BY g."userId", g.area, g.action, g.src
),
"inserted" AS (
  INSERT INTO "StaffPermission" ("id", "userId", "area", "action", "grantedById", "grantedAt")
  SELECT gen_random_uuid()::text, "userId", area, action, "grantedById", CURRENT_TIMESTAMP FROM "grants"
  ON CONFLICT ("userId", "area", "action") DO NOTHING
  RETURNING "userId", "area", "action"
)
INSERT INTO "StaffPermissionEvent" ("id", "actorId", "userId", "area", "action", "fromAllowed", "toAllowed", "source", "createdAt")
SELECT gen_random_uuid()::text, 'system', i."userId", i.area, i.action, false, true, g.src, CURRENT_TIMESTAMP
FROM "inserted" i JOIN "grants" g ON g."userId" = i."userId" AND g.area = i.area AND g.action = i.action;
