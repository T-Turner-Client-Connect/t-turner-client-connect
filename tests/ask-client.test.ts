import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { setupLedger } from "@/lib/services/ledger";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { portalUploadDocument } from "@/lib/services/documents";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { createClientRequest, sendClientRequest } from "@/lib/services/client-requests";
import { addAskItem, askClientView, askLetterPdf, ASK_CLIENT_ON_HOLD, editAskItem, portalAskLetterPdf, portalExplainRequest, removeAskItem, runAskClientTool, sendAskItems } from "@/lib/services/ask-client";
import { auditFileView, buildAuditFilePdf } from "@/lib/services/audit-file";

// Fictional businesses and people only.
const pdf = async (label: string) => {
  const d = await PDFDocument.create();
  d.addPage([300, 300]).drawText(label, { x: 20, y: 150 });
  return d.save();
};

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const outsider = await makeUser("STAFF", "Morgan");
  const biz = await createClient(tabitha, { businessName: "Juniper Example Studio (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  const other = await createClient(tabitha, { businessName: "Cedar Example Works (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(biz.id, other.id);
  for (const c of [biz, other]) await setupLedger(tabitha, c.id, { basis: "CASH" });
  const { token } = await invitePortalUser(tabitha, biz.id, { email: "owner@juniper.example", name: "Robin Example", role: "OWNER" });
  const login = await acceptPortalInvite(token!, "Owner-Pass-12345");
  const { token: t2 } = await invitePortalUser(tabitha, other.id, { email: "owner@cedar.example", name: "Sky Example", role: "OWNER" });
  const otherLogin = await acceptPortalInvite(t2!, "Owner-Pass-67890");
  const portal = { id: login.id, name: login.name, email: login.email };
  return { tabitha, outsider, biz, other, portal, otherPortal: { id: otherLogin.id, name: otherLogin.name, email: otherLogin.email } };
}
const notices = (portalUserId: string) => prisma.notification.count({ where: { portalUserId, kind: "DOCUMENT_REQUEST" } });

describe("Ask Client: prepare, review and hold until Tabitha authorizes client communications", () => {
  it("Coetha's items are drafts; staff edit, add and remove them; nothing reaches the client while communications are on hold", async () => {
    const s = await setup();
    // Coetha prepares two items (as if from chat); asking twice doesn't duplicate.
    const r = await runAskClientTool(s.tabitha, s.biz.id, { items: [
      { title: "Receipt or invoice for check #1043, $412.00, paid March 4, 2026", reason: "To record it to the right expense account." },
      { title: "What the $2,500.00 deposit on April 2, 2026 was", reason: "A sale, a loan or money from the owner are each recorded differently." },
    ] });
    expect(r.prepared!.map((p) => p.result)).toEqual(["Draft added to the Ask Client list", "Draft added to the Ask Client list"]);
    const again = await runAskClientTool(s.tabitha, s.biz.id, { items: [{ title: "Receipt or invoice for check #1043, $412.00, paid March 4, 2026", reason: "x" }] });
    expect(again.prepared![0].result).toBe("Already on the Ask Client list");

    let v = await askClientView(s.tabitha, s.biz.id);
    expect(v.drafts.map((d) => [d.source, d.status, d.kind])).toEqual([["COETHA", "DRAFT", "SUPPORTING"], ["COETHA", "DRAFT", "SUPPORTING"]]);
    expect(v.rolloutAuthorized).toBe(false);

    // Edit one, add one by hand, remove one.
    await editAskItem(s.tabitha, s.biz.id, v.drafts[0].id, { title: "Receipt for check #1043 ($412.00, March 4, 2026)", reason: "To record it correctly.", dueAt: "2026-12-01" });
    const added = await addAskItem(s.tabitha, s.biz.id, { title: "Signed loan agreement for the equipment loan", reason: "To split each payment into principal and interest." });
    await removeAskItem(s.tabitha, s.biz.id, v.drafts[1].id);
    v = await askClientView(s.tabitha, s.biz.id);
    expect(v.drafts.map((d) => d.title)).toEqual(["Receipt for check #1043 ($412.00, March 4, 2026)", "Signed loan agreement for the equipment loan"]);
    expect(await prisma.auditLog.count({ where: { clientId: s.biz.id, action: "ask_client.edited" } })).toBe(1);

    // Sending is refused until client communications are authorized: no portal notice, no email, nothing visible.
    await expect(sendAskItems(s.tabitha, s.biz.id, v.drafts.map((d) => d.id))).rejects.toThrow(ASK_CLIENT_ON_HOLD);
    await expect(sendClientRequest(s.tabitha, s.biz.id, added.request!.id)).rejects.toThrow("Client communications are on hold");
    // Any other path that would send an Ask Client item keeps it as a draft.
    const direct = await createClientRequest(s.tabitha, s.biz.id, { kind: "SUPPORTING", title: "Explain the transfer on May 5, 2026", askClient: true }, { send: true });
    expect(direct.request!.status).toBe("DRAFT");
    expect(await notices(s.portal.id)).toBe(0);
    expect(await prisma.documentRequest.count({ where: { clientId: s.biz.id, status: "OPEN" } })).toBe(0);

    // The office's existing requests are NOT held: an ordinary supporting request still goes out at once,
    // and it never appears on the Ask Client list.
    const office = await createClientRequest(s.tabitha, s.biz.id, { kind: "SUPPORTING", title: "Receipts for October purchases" }, { send: true });
    expect(office.request).toMatchObject({ status: "OPEN", askClient: false });
    expect(await notices(s.portal.id)).toBeGreaterThan(0);
    expect((await askClientView(s.tabitha, s.biz.id)).waiting).toHaveLength(0);

    // Someone without access to this business can't see or change the list.
    await expect(askClientView(s.outsider, s.biz.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addAskItem(s.outsider, s.biz.id, { title: "Anything" })).rejects.toBeInstanceOf(ForbiddenError);

    // The request letter is ready for review on letterhead even while on hold.
    const letter = await askLetterPdf(s.tabitha, s.biz.id);
    const text = Buffer.from(letter.bytes).toString("latin1");
    expect(text.startsWith("%PDF")).toBe(true);
    expect(letter.ids).toHaveLength(3);
    expect(await prisma.auditLog.count({ where: { clientId: s.biz.id, action: "ask_client.letter_prepared" } })).toBe(1);
  });

  it("after Tabitha authorizes, sending reaches only this client; the client uploads or explains; the upload goes to Coetha; the explanation is evidence only", async () => {
    const s = await setup();
    await setOwnerSwitch(s.tabitha, "coetha", true);
    const a = await addAskItem(s.tabitha, s.biz.id, { title: "Receipt for check #2201 ($88.10)", reason: "To categorize it." });
    const b = await addAskItem(s.tabitha, s.biz.id, { title: "What the $900.00 deposit on June 9, 2026 was", reason: "Deposits are recorded by what they are." });
    await setOwnerSwitch(s.tabitha, "clientRollout", true);
    expect(await sendAskItems(s.tabitha, s.biz.id, [a.request!.id, b.request!.id])).toBe(2);
    expect(await notices(s.portal.id)).toBeGreaterThan(0);
    expect(await notices(s.otherPortal.id)).toBe(0);

    // The client's copy of the letter: sent items only; another business's login gets nothing.
    expect((await portalAskLetterPdf(s.portal, s.biz.id)).ids.sort()).toEqual([a.request!.id, b.request!.id].sort());
    await expect(portalAskLetterPdf(s.otherPortal, s.biz.id)).rejects.toBeInstanceOf(ForbiddenError);

    // Upload against item A: filed with the request and queued for Coetha (no staff re-upload).
    const doc = await portalUploadDocument(s.portal, { clientId: s.biz.id, requestId: a.request!.id, bytes: await pdf("Receipt 2201"), originalName: "receipt-2201.pdf" });
    expect((await prisma.documentRequest.findUniqueOrThrow({ where: { id: a.request!.id } })).status).toBe("SUBMITTED");
    expect(await prisma.coethaDocJob.findUnique({ where: { documentId: doc.id } })).toMatchObject({ clientId: s.biz.id, status: "QUEUED" });

    // Explain item B in writing. Another business's login can't answer it.
    await expect(portalExplainRequest(s.otherPortal, s.biz.id, b.request!.id, "Not mine")).rejects.toBeInstanceOf(ForbiddenError);
    await portalExplainRequest(s.portal, s.biz.id, b.request!.id, "That was a refund from our supplier for returned flour.");
    const bRow = await prisma.documentRequest.findUniqueOrThrow({ where: { id: b.request!.id } });
    expect(bRow).toMatchObject({ status: "SUBMITTED", clientExplanation: "That was a refund from our supplier for returned flour.", explainedByPortalId: s.portal.id });
    // Answering sends the client nothing new, and posts nothing.
    expect(await prisma.journalEntry.count({ where: { clientId: s.biz.id } })).toBe(0);

    const v = await askClientView(s.tabitha, s.biz.id);
    expect(v.answered.map((x) => x.id).sort()).toEqual([a.request!.id, b.request!.id].sort());
    expect(v.reading[doc.id]).toBe("QUEUED");
  });

  it("the Audit File organizes by year, month, category and account, exports one PDF on letterhead, and logs every export", async () => {
    const s = await setup();
    await setOwnerSwitch(s.tabitha, "clientRollout", true);
    const a = await addAskItem(s.tabitha, s.biz.id, { title: "Invoice for the March equipment repair", reason: "To support the repair expense." });
    const b = await addAskItem(s.tabitha, s.biz.id, { title: "What the April 2 transfer was", reason: "To record it correctly." });
    await sendAskItems(s.tabitha, s.biz.id, [a.request!.id, b.request!.id]);
    const doc = await portalUploadDocument(s.portal, { clientId: s.biz.id, requestId: a.request!.id, bytes: await pdf("Repair invoice"), originalName: "repair.pdf" });
    await prisma.document.update({ where: { id: doc.id }, data: { year: 2026, month: 3 } });
    await portalExplainRequest(s.portal, s.biz.id, b.request!.id, "Moved to our savings account at the same bank.");
    // Another business's document never appears here.
    await portalUploadDocument(s.otherPortal, { clientId: s.other.id, year: 2026, docType: "OTHER", bytes: await pdf("Other business"), originalName: "other.pdf" }).catch(() => null);

    const all = await auditFileView(s.tabitha, s.biz.id, {});
    expect(all.rows.map((r) => r.title)).toEqual([doc.title]);
    expect(all.explanations.map((e) => e.clientExplanation)).toEqual(["Moved to our savings account at the same bank."]);
    expect((await auditFileView(s.tabitha, s.biz.id, { year: 2026, month: 3 })).rows).toHaveLength(1);
    expect((await auditFileView(s.tabitha, s.biz.id, { year: 2026, month: 4 })).rows).toHaveLength(0);
    expect((await auditFileView(s.tabitha, s.biz.id, { category: "PAYROLL" })).rows).toHaveLength(0);
    await expect(auditFileView(s.outsider, s.biz.id, {})).rejects.toBeInstanceOf(ForbiddenError);

    const out = await buildAuditFilePdf(s.tabitha, s.biz.id, { year: 2026 });
    const merged = await PDFDocument.load(out.bytes);
    expect(merged.getPageCount()).toBeGreaterThanOrEqual(2); // letterhead cover + index, then the invoice
    expect(await prisma.auditLog.findFirstOrThrow({ where: { clientId: s.biz.id, action: "audit_file.exported" } })).toMatchObject({ actorId: s.tabitha.id });
    expect(await prisma.documentAccessLog.count({ where: { documentId: doc.id, action: "DOWNLOAD", staffUserId: s.tabitha.id } })).toBe(1);
  });
});
