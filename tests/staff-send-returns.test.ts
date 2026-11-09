import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { fileReturn, releaseReturn } from "@/lib/services/tax-returns";
import { removeFiling } from "@/lib/services/accepted-returns";
import { canSendReturns } from "@/lib/services/return-senders";
import { createFiling, setFilingStatusByStaff } from "@/lib/services/tax";

// Fictional clients and staff only.
const pdf = (tag: string) => new TextEncoder().encode(`%PDF-1.4\n% fictional return ${tag}\n`);

describe("Staff send tax returns to their clients", () => {
  beforeEach(resetDb);

  async function setup() {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const preparer = await makeUser("STAFF", "Assigned Preparer");
    const other = await makeUser("STAFF", "Other Staff");
    const client = await createClient(tabitha, { firstName: "Avery", lastName: "Example", clientType: "INDIVIDUAL", status: "ACTIVE", assignedToId: preparer.id });
    return { tabitha, preparer, other, client };
  }

  it("the assigned preparer can send the return; other staff can't; removing a filing stays with Tabitha", async () => {
    const s = await setup();
    expect(await canSendReturns(s.preparer, s.client.id)).toBe(true);
    expect(await canSendReturns(s.other, s.client.id)).toBe(false);
    expect(await canSendReturns(s.tabitha, s.client.id)).toBe(true);

    for (const [returnType, jurisdiction] of [["1040", "FEDERAL"], ["40", "AL"]]) {
      const f = await createFiling(s.preparer, { clientId: s.client.id, taxYear: 2025, returnType, jurisdiction, filingType: "ORIGINAL" });
      await setFilingStatusByStaff(s.preparer, f.id, { status: "SUBMITTED", submission: { form8879Confirmed: true, overrideReason: "Filed in TaxAct before summaries were used (fictional)" } });
      await setFilingStatusByStaff(s.preparer, f.id, { status: "ACCEPTED", verificationNote: "Ack (fictional)" });
    }
    const fed = await fileReturn(s.preparer, { clientId: s.client.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL", bytes: pdf("fed"), originalName: "1040.pdf" });
    const al = await fileReturn(s.preparer, { clientId: s.client.id, taxYear: 2025, returnType: "40", jurisdiction: "AL", filingType: "ORIGINAL", bytes: pdf("al"), originalName: "al40.pdf" });
    await prisma.document.updateMany({ where: { id: { in: [fed.id, al.id] } }, data: { scanStatus: "CLEAN" } });

    await expect(releaseReturn(s.other, fed.id)).rejects.toBeInstanceOf(ForbiddenError);
    await releaseReturn(s.preparer, fed.id);
    await releaseReturn(s.preparer, al.id);
    const sent = await prisma.document.findMany({ where: { id: { in: [fed.id, al.id] } } });
    expect(sent.every((d) => d.visibility === "PUBLISHED")).toBe(true);

    const filing = await prisma.filingRecord.findFirstOrThrow({ where: { clientId: s.client.id, jurisdiction: "FEDERAL" } });
    await expect(removeFiling(s.preparer, filing.id, "wrong year entered")).rejects.toBeInstanceOf(ForbiddenError);
  });
});
