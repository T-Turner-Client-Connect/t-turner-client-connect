import { chicagoToday } from "@/lib/dates";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { deadlineFlag, submitNotice } from "@/lib/services/notices";

let n = 0;
const pdf = () => ({ bytes: new TextEncoder().encode(`%PDF-1.4\n% fictional notice ${n++}\n`), originalName: "notice.pdf" });
beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Upload Audit or Tax Notice", () => {
  it("creates a case in the right year, links the files, alerts Tabitha and the assigned staff, and claims only receipt", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const daria = await makeUser("STAFF", "Daria");
    const c = await createClient(tabitha, { firstName: "Fictional", lastName: "Client", clientType: "INDIVIDUAL", status: "ACTIVE", assignedToId: daria.id });
    const other = await createClient(tabitha, { businessName: "Other LLC", clientType: "BUSINESS", status: "ACTIVE" });
    const { token } = await invitePortalUser(tabitha, c.id, { email: "client@fictional.example", name: "Client", role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Client-Pass-12345");
    const user = { id: u.id, name: u.name, email: u.email };
    await expect(submitNotice(user, other.id, { taxYear: "2024", agency: "IRS" }, [pdf()])).rejects.toBeInstanceOf(ForbiddenError);
    await expect(submitNotice(user, c.id, { taxYear: "2024", agency: "IRS" }, [])).rejects.toThrow(/Choose the notice/);
    const due = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const r = await submitNotice(user, c.id, { taxYear: "2024", agency: "IRS", receivedOn: chicagoToday(), responseDueOn: due, message: "CP2000 letter" }, [pdf(), pdf()]);
    expect([r.case.status, r.case.taxYear, r.documents.length]).toEqual(["RECEIVED", 2024, 2]);
    const docs = await prisma.document.findMany({ where: { noticeCaseId: r.case.id } });
    expect(docs.map((d) => [d.year, d.clientId, d.docType])).toEqual([[2024, c.id, "AGENCY_LETTER"], [2024, c.id, "AGENCY_LETTER"]]);
    const tasks = await prisma.task.findMany({ where: { clientId: c.id } });
    expect(tasks.map((t) => t.assigneeId).sort()).toEqual([daria.id, tabitha.id].sort());
    expect(tasks.every((t) => t.priority === "HIGH")).toBe(true); // due within 7 days
    expect(deadlineFlag(r.case)?.tone).toBe("red");
    // "Not sure" is allowed for the year and the agency.
    const unsure = await submitNotice(user, c.id, { taxYear: "unsure", agency: "NOT_SURE" }, [pdf()]);
    expect(unsure.case.taxYear).toBeNull();
  });
});
