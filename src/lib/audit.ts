import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export type AuditEntry = {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  clientId?: string | null;
  details?: Prisma.InputJsonValue;
};

export function audit(db: Db, entry: AuditEntry) {
  return db.auditLog.create({ data: entry });
}

/** Names of the fields whose values differ. Values are not recorded. */
export function changedFields<T extends Record<string, unknown>>(before: T, after: Partial<T>): string[] {
  return Object.keys(after).filter((key) => {
    const a = before[key];
    const b = after[key];
    return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
  });
}
