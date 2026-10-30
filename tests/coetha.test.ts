import { describe, expect, it, beforeEach } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { canOpenCoetha, parseCoethaUrl, setCoethaLink } from "@/lib/services/bookkeeping-profile";

beforeEach(async () => {
  await resetDb();
});

describe("Work with Coetha", () => {
  it("accepts only claude.ai Project or conversation links", () => {
    expect(parseCoethaUrl("https://claude.ai/project/0199abcd-1234")).toBe("https://claude.ai/project/0199abcd-1234");
    expect(parseCoethaUrl("https://claude.ai/chat/abc-123?x=1#y")).toBe("https://claude.ai/chat/abc-123");
    expect(() => parseCoethaUrl("http://claude.ai/project/abc")).toThrow(/claude.ai/);
    expect(() => parseCoethaUrl("https://claude.ai.evil.example/project/abc")).toThrow(/claude.ai/);
    expect(() => parseCoethaUrl("https://user:pw@claude.ai/project/abc")).toThrow(/never a username or password/);
    expect(() => parseCoethaUrl("https://claude.ai/settings")).toThrow(/Project/);
  });

  it("each business has its own link; only Tabitha sets it; Admins and assigned staff can open it", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const otherAdmin = await makeUser("ADMIN", "Second");
    const daria = await makeUser("STAFF", "Daria");
    const staff2 = await makeUser("STAFF", "Other Staff");
    // One owner, two businesses — two separate bookkeeping profiles.
    const energy = await createClient(tabitha, { businessName: "Fictional Energy Co", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
    const drive = await createClient(tabitha, { businessName: "Fictional Drive Co", clientType: "BUSINESS", status: "ACTIVE" });
    for (const c of [energy, drive]) await saveProfile(tabitha, c.id, { active: true, frequency: "MONTHLY", payroll: false });
    await expect(setCoethaLink(daria, energy.id, "https://claude.ai/project/energy-1")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setCoethaLink(otherAdmin, energy.id, "https://claude.ai/project/energy-1")).rejects.toBeInstanceOf(ForbiddenError);
    await setCoethaLink(tabitha, energy.id, "https://claude.ai/project/energy-1");
    await setCoethaLink(tabitha, drive.id, "https://claude.ai/project/drive-2");
    const links = await prisma.bookkeepingProfile.findMany({ where: { clientId: { in: [energy.id, drive.id] } }, select: { clientId: true, coethaUrl: true } });
    expect(Object.fromEntries(links.map((l) => [l.clientId, l.coethaUrl]))).toEqual({ [energy.id]: "https://claude.ai/project/energy-1", [drive.id]: "https://claude.ai/project/drive-2" });
    expect([await canOpenCoetha(daria, energy.id), await canOpenCoetha(daria, drive.id), await canOpenCoetha(staff2, energy.id), await canOpenCoetha(otherAdmin, drive.id)]).toEqual([true, false, false, true]);
    await setCoethaLink(tabitha, drive.id, null);
    expect((await prisma.bookkeepingProfile.findUniqueOrThrow({ where: { clientId: drive.id } })).coethaUrl).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: { startsWith: "bookkeeping.coetha_link" } } })).toBe(3);
  });
});
