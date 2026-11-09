import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { setStaffPermissions } from "@/lib/auth/permissions";
import { createClient } from "@/lib/services/clients";
import { fileReturn, releaseReturn } from "@/lib/services/tax-returns";
import { removeFiling } from "@/lib/services/accepted-returns";
import { canSendReturns } from "@/lib/services/return-senders";
import { createFiling, setFilingStatusByStaff } from "@/lib/services/tax";

// Fictional clients and staff only.
const pdf = (tag: string) => new TextEncoder().encode(`%PDF-1.4\n% fictional return ${tag}\n`);

describe("Authorized staff send tax returns to the client's vault", () => {
  beforeEach(resetDb);

  async function setup() {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const preparer = await makeUser("STAFF", "Assigned Preparer");
    const other = await makeUser("STAFF", "Other Staff");
    const officeWide = await makeUser("STAFF", "Office-wide Tax Staff");
    const client = await createClient(tabitha, { firstName: "Avery", lastName: "Example", clientType: "INDIVIDUAL", status: "ACTIVE", assignedToId: preparer.id });
    return { tabitha, preparer, other, officeWide, client };
  }

  async function acceptedReturns(s: Awaited<ReturnType<typeof setup>>) {
    for (const [returnType, jurisdiction] of [["1040", "FEDERAL"], ["40", "AL"]]) {
      const f = await createFiling(s.preparer, { clientId: s.client.id, taxYear: 2025, returnType, jurisdiction, filingType: "ORIGINAL" });
      await setFilingStatusByStaff(s.preparer, f.id, { status: "SUBMITTED", submission: { form8879Confirmed: true, overrideReason: "Filed in TaxAct before summaries were used (fictional)" } });
      await setFilingStatusByStaff(s.preparer, f.id, { status: "ACCEPTED", verificationNote: "Ack (fictional)" });
    }
    const fed = await fileReturn(s.preparer, { clientId: s.client.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL", bytes: pdf("fed"), originalName: "1040.pdf" });
    const al = await fileReturn(s.preparer, { clientId: s.client.id, taxYear: 2025, returnType: "40", jurisdiction: "AL", filingType: "ORIGINAL", bytes: pdf("al"), originalName: "al40.pdf" });
    await prisma.document.updateMany({ where: { id: { in: [fed.id, al.id] } }, data: { scanStatus: "CLEAN" } });
    return { fed, al };
  }

  it("the owner, Admins, the assigned preparer and staff with Tax → All clients may send; other staff may not", async () => {
    const s = await setup();
    expect(await canSendReturns(s.tabitha, s.client.id)).toBe(true);
    expect(await canSendReturns(s.preparer, s.client.id)).toBe(true);
    expect(await canSendReturns(s.other, s.client.id)).toBe(false);
    expect(await canSendReturns(s.officeWide, s.client.id)).toBe(false);
    await setStaffPermissions(s.tabitha, s.officeWide.id, ["tax.all_clients"]);
    expect(await canSendReturns(s.officeWide, s.client.id)).toBe(true);
    // Only Tabitha grants it.
    await expect(setStaffPermissions(s.preparer, s.other.id, ["tax.all_clients"])).rejects.toThrow();
  });

  it("unassigned staff without the permission are refused; nothing is published", async () => {
    const s = await setup();
    const { fed } = await acceptedReturns(s);
    await expect(releaseReturn(s.other, fed.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: fed.id } })).visibility).not.toBe("PUBLISHED");
    expect(await prisma.auditLog.count({ where: { action: "tax.return_released" } })).toBe(0);
  });

  it("records the Form 8879 confirmation, verifies client and year, and audits every delivery with the sender", async () => {
    const s = await setup();
    await setStaffPermissions(s.tabitha, s.officeWide.id, ["tax.all_clients"]);
    const { fed, al } = await acceptedReturns(s);

    // The 8879 confirmation and the person who recorded it are on the filing history.
    const submitted = await prisma.filingStatusEvent.findMany({ where: { toValue: "SUBMITTED" } });
    expect(submitted).toHaveLength(2);
    for (const e of submitted) { expect(e.actorId).toBe(s.preparer.id); expect(e.verificationNote).toMatch(/Owner filing/); }
    const gate = await prisma.auditLog.findMany({ where: { action: { contains: "filing" }, actorId: s.preparer.id } });
    expect(JSON.stringify(gate)).toContain("form8879Confirmed");

    // A file whose year doesn't match its filing can't be sent.
    await prisma.document.update({ where: { id: al.id }, data: { year: 2024 } });
    await expect(releaseReturn(s.preparer, al.id)).rejects.toThrow(/tax year doesn't match/);
    await prisma.document.update({ where: { id: al.id }, data: { year: 2025 } });

    await releaseReturn(s.officeWide, fed.id);
    await releaseReturn(s.preparer, al.id);
    const sent = await prisma.document.findMany({ where: { id: { in: [fed.id, al.id] } } });
    expect(sent.every((d) => d.visibility === "PUBLISHED")).toBe(true);

    const logs = await prisma.auditLog.findMany({ where: { action: "tax.return_released" }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => [l.actorId, l.clientId, (l.details as { sentBy: string }).sentBy, (l.details as { taxYear: number }).taxYear])).toEqual([
      [s.officeWide.id, s.client.id, "TAX_ALL_CLIENTS", 2025],
      [s.preparer.id, s.client.id, "ASSIGNED", 2025],
    ]);

    const filing = await prisma.filingRecord.findFirstOrThrow({ where: { clientId: s.client.id, jurisdiction: "FEDERAL" } });
    await expect(removeFiling(s.preparer, filing.id, "wrong year entered")).rejects.toBeInstanceOf(ForbiddenError);
  });
});
