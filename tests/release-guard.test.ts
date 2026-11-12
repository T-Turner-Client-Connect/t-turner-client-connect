import { beforeEach, describe, expect, it, afterEach } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { attachFilingDocument, createFiling, publishFilingUpdate } from "@/lib/services/tax";
import { authorizeDownload, downloadToken, setVisibility, staffUploadDocument } from "@/lib/services/documents";
import { staffSendMessage } from "@/lib/services/messaging";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { setReturnGate } from "@/lib/services/return-gate";

// Placeholder PDFs here carry no return text; the return upload gate itself is tested in return-gate.test.ts.
beforeEach(() => setReturnGate(async () => "VERIFIED"));
afterEach(() => setReturnGate(null));

// Fictional clients only. The release rules of the Publish button now apply to every path that
// can put a document in front of a client: filing updates, filing attachments, message attachments.
beforeEach(resetDb);

const pdf = (label: string) => new TextEncoder().encode(`%PDF-1.4\n% ${label} ${Math.random()}\n`);

async function setup() {
  const staff = await makeUser("ADMIN", "Tabitha");
  const client = await createClient(staff, { firstName: "Rowan", lastName: "Example", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const { token } = await invitePortalUser(staff, client.id, { email: "rowan@fictional.example", name: "Rowan Example", role: "OWNER" });
  const login = await acceptPortalInvite(token!, "Client-Pass-12345");
  const filing = await createFiling(staff, { clientId: client.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
  // Staff-only documents, scanned clean.
  const doc = async (title: string, data: { category: "TAXES" | "BOOKKEEPING" | "IDENTITY" | "OTHER"; docType?: string; reportType?: "PROFIT_AND_LOSS"; year?: number }) => {
    // Identity files have their own upload; the fictional record is created as OTHER and then marked IDENTITY.
    const d = await staffUploadDocument(staff, { clientId: client.id, category: data.category === "IDENTITY" ? "OTHER" : data.category, title, visibility: "STAFF_ONLY", bytes: pdf(title), originalName: `${title}.pdf`, notify: false, docType: data.docType ?? null, reportType: data.reportType ?? null, year: data.year ?? null });
    return prisma.document.update({ where: { id: d.id }, data: { scanStatus: "CLEAN", category: data.category } });
  };
  return { staff, client, login, filing, doc };
}
const visibility = async (id: string) => (await prisma.document.findUniqueOrThrow({ where: { id } })).visibility;

describe("No document reaches a client without its release checks", () => {
  it("a document that isn't a tax acknowledgment, notice or correspondence can't be attached to a filing", async () => {
    const s = await setup();
    const pnl = await s.doc("Unapproved P&L", { category: "BOOKKEEPING", reportType: "PROFIT_AND_LOSS" });
    const license = await s.doc("Driver license", { category: "IDENTITY", docType: "DRIVERS_LICENSE" });
    const nonprofit = await s.doc("Board minutes", { category: "OTHER", docType: "NONPROFIT_ITEM" });
    const returnCopy = await s.doc("2025 return", { category: "TAXES", docType: "FEDERAL_RETURN", year: 2025 });
    for (const d of [pnl, license, nonprofit, returnCopy]) {
      await expect(attachFilingDocument(s.staff, s.filing.id, d.id, "OFFICIAL_ACK")).rejects.toThrow(/Only a tax acknowledgment, notice or correspondence/);
      // Nothing was relabeled: the document keeps its own category and release step.
      expect((await prisma.document.findUniqueOrThrow({ where: { id: d.id } })).filingId).toBeNull();
    }
    // A real acknowledgment still attaches.
    const ack = await s.doc("IRS acknowledgment", { category: "TAXES" });
    await attachFilingDocument(s.staff, s.filing.id, ack.id, "OFFICIAL_ACK");
    expect((await prisma.document.findUniqueOrThrow({ where: { id: ack.id } })).filingId).toBe(s.filing.id);
  });

  it("publishing a filing update holds back anything that fails the release checks (the original bypass), and the client's server-side download of the held report is refused", async () => {
    const s = await setup();
    const ack = await s.doc("IRS acknowledgment", { category: "TAXES" });
    await attachFilingDocument(s.staff, s.filing.id, ack.id, "OFFICIAL_ACK");
    // The original problem: documents already linked to a filing as an "acknowledgment" before this
    // fix (relabeled TAXES), e.g. an unapproved P&L and an identity document.
    const pnl = await s.doc("Unapproved P&L", { category: "BOOKKEEPING", reportType: "PROFIT_AND_LOSS" });
    const license = await s.doc("Driver license", { category: "IDENTITY", docType: "DRIVERS_LICENSE" });
    await prisma.document.update({ where: { id: pnl.id }, data: { filingId: s.filing.id, filingDocType: "OFFICIAL_ACK", category: "TAXES", docType: "PNL" } });
    await prisma.document.update({ where: { id: license.id }, data: { filingId: s.filing.id, filingDocType: "OFFICIAL_ACK" } });

    expect(await publishFilingUpdate(s.staff, s.filing.id, "portal_only")).toBe(1);
    expect(await visibility(ack.id)).toBe("PUBLISHED");
    expect(await visibility(pnl.id)).toBe("STAFF_ONLY");
    expect(await visibility(license.id)).toBe("STAFF_ONLY");
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "filing.published", entityId: s.filing.id } });
    expect((log.details as { heldBack: string[] }).heldBack.sort()).toEqual([pnl.id, license.id].sort());

    // Server-side: the client's login can open the acknowledgment and is refused the others.
    const viewer = { portalUserId: s.login.id };
    expect(await authorizeDownload(downloadToken(ack.id, viewer), viewer)).not.toBeNull();
    expect(await authorizeDownload(downloadToken(pnl.id, viewer), viewer)).toBeNull();
    // (A driver's license is a client's own identity file: it opens through Identity Documents by
    // design, not through publishing, so it is checked above as staying staff-only.)
  });

  it("message attachments follow the same rules (a nonprofit item or an unreleased return can't go out in a message)", async () => {
    const s = await setup();
    const nonprofit = await s.doc("Board minutes", { category: "OTHER", docType: "NONPROFIT_ITEM" });
    const returnCopy = await s.doc("2025 return", { category: "TAXES", docType: "FEDERAL_RETURN", year: 2025 });
    for (const d of [nonprofit, returnCopy]) {
      await expect(staffSendMessage(s.staff, { clientId: s.client.id, subject: "Your file", body: "Attached.", channel: "PORTAL", attachmentIds: [d.id] })).rejects.toThrow(/can't be sent as an attachment/);
      expect(await visibility(d.id)).toBe("STAFF_ONLY");
    }
    // An ordinary tax document still goes out as before.
    const letter = await s.doc("Letter from the IRS", { category: "TAXES" });
    await staffSendMessage(s.staff, { clientId: s.client.id, subject: "Your file", body: "Attached.", channel: "PORTAL", attachmentIds: [letter.id] });
    expect(await visibility(letter.id)).toBe("PUBLISHED");
    // The Publish button's own messages are unchanged.
    await expect(setVisibility(s.staff, nonprofit.id, "PUBLISHED")).rejects.toThrow(/Nonprofit portfolio documents/);
  });
});
