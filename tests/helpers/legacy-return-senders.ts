/**
 * The earlier "who may send a return" rule (owner, Admins, the client's assigned preparer), used
 * only by the older delivery tests so the "waiting for Tabitha" path they cover stays tested.
 * The real rule (any staff member sends) is tested in tests/staff-send-returns.test.ts.
 */
export async function legacyReturnSenders(importOriginal: () => Promise<unknown>) {
  const real = (await importOriginal()) as typeof import("@/lib/services/return-senders");
  return {
    ...real,
    canSendReturns: async (actor: import("@/lib/auth/actor").Actor, clientId: string) => {
      const { isReportApprover } = await import("@/lib/services/bookkeeping-clients");
      const { canEditTaxPrep } = await import("@/lib/services/tax-prep");
      return (await isReportApprover(actor)) || (await canEditTaxPrep(actor, clientId));
    },
  };
}
