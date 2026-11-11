import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { setupLedger } from "@/lib/services/ledger";
import { registerAccount } from "@/lib/services/bank-accounts";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { authorizeDownload, downloadToken, portalUploadDocument, staffUploadDocument } from "@/lib/services/documents";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { requireClientAccess } from "@/lib/portal/access";
import { loadPortalDocuments } from "@/lib/portal/views";
import { addAskItem, askClientView, runAskClientTool, sendAskItems } from "@/lib/services/ask-client";
import { auditFileView, parseAuditFilter } from "@/lib/services/audit-file";

// Fictional business and people only. One client upload, one stored file, many authorized views:
// the request, the client's Document Vault, Coetha's reading and the staff Audit File.
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
  const biz = await createClient(tabitha, { businessName: "Willow Example Florals (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(biz.id);
  await setupLedger(tabitha, biz.id, { basis: "CASH" });
  const chk = await registerAccount(tabitha, biz.id, { institution: "Example Community Bank", accountType: "CHECKING", nickname: "Operating", last4: "4321", gl: "NEW" });
  const login = async (email: string, name: string) => {
    const { token } = await invitePortalUser(tabitha, biz.id, { email, name, role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Client-Pass-12345");
    return { id: u.id, name: u.name, email: u.email };
  };
  const owner = await login("owner@willow.example", "Avery Example");
  const helper = await login("helper@willow.example", "Drew Example"); // no document access
  await prisma.portalAccess.updateMany({ where: { clientId: biz.id, portalUserId: helper.id }, data: { canViewDocuments: false } });
  await setOwnerSwitch(tabitha, "coetha", true);
  await setOwnerSwitch(tabitha, "clientRollout", true);
  return { tabitha, biz, chk, owner, helper };
}

const vault = async (s: Awaited<ReturnType<typeof setup>>, who: { id: string }) => loadPortalDocuments(s.biz.id, await requireClientAccess(who.id, s.biz.id), { viewer: who.id });

describe("Coetha's requests, the client's answer and the Document Vault", () => {
  it("Coetha's request carries its month and account; asking again adds nothing", async () => {
    const s = await setup();
    const item = { title: "Receipt for check #1043 ($412.00, March 4, 2026)", reason: "To record it to the right expense.", month: "2026-03", account_last4: "4321" };
    expect((await runAskClientTool(s.tabitha, s.biz.id, { items: [item] })).prepared![0].result).toBe("Draft added to the Ask Client list");
    expect((await runAskClientTool(s.tabitha, s.biz.id, { items: [item] })).prepared![0].result).toBe("Already on the Ask Client list");
    const r = await prisma.documentRequest.findFirstOrThrow({ where: { clientId: s.biz.id, askClient: true } });
    expect(r).toMatchObject({ bookkeepingAccountId: s.chk.id, status: "DRAFT" });
    expect(r.periodStart?.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(r.periodEnd?.toISOString().slice(0, 10)).toBe("2026-03-31");
    expect(await prisma.documentRequest.count({ where: { clientId: s.biz.id } })).toBe(1);
  });

  it("one upload, one stored file: it answers the request, appears in the uploader's Vault with its request and status, reaches Coetha and the Audit File", async () => {
    const s = await setup();
    const a = await addAskItem(s.tabitha, s.biz.id, { title: "Receipt for check #2201 ($88.10)", reason: "To categorize it." });
    await sendAskItems(s.tabitha, s.biz.id, [a.request!.id]);
    const filesBefore = await prisma.storedFile.count();
    const doc = await portalUploadDocument(s.owner, { clientId: s.biz.id, requestId: a.request!.id, bytes: await pdf("Receipt 2201"), originalName: "receipt-2201.pdf" });
    expect(await prisma.storedFile.count()).toBe(filesBefore + 1);
    expect(await prisma.document.count({ where: { clientId: s.biz.id } })).toBe(1);

    // The client's Vault: the same document, with the request it answered and its status.
    const mine = await vault(s, s.owner);
    expect(mine.map((d) => d.id)).toEqual([doc.id]);
    expect(mine[0].request).toMatchObject({ title: "Receipt for check #2201 ($88.10)", status: "SUBMITTED" });
    expect(await authorizeDownload(downloadToken(doc.id, { portalUserId: s.owner.id }), { portalUserId: s.owner.id })).not.toBeNull();

    // Coetha reads that same document (no staff re-upload); the Audit File lists it by its request.
    expect(await prisma.coethaDocJob.findUnique({ where: { documentId: doc.id } })).toMatchObject({ clientId: s.biz.id });
    const audit = await auditFileView(s.tabitha, s.biz.id, parseAuditFilter({}));
    expect(audit.rows.find((r) => r.id === doc.id)?.request?.title).toBe("Receipt for check #2201 ($88.10)");
    expect((await askClientView(s.tabitha, s.biz.id)).answered.map((x) => x.id)).toEqual([a.request!.id]);
  });

  it("a login without document access, and staff-only or unreleased files, never reach the portal, in the list or by download", async () => {
    const s = await setup();
    const a = await addAskItem(s.tabitha, s.biz.id, { title: "What the $900.00 deposit was", reason: "To record it." });
    await sendAskItems(s.tabitha, s.biz.id, [a.request!.id]);
    const doc = await portalUploadDocument(s.owner, { clientId: s.biz.id, requestId: a.request!.id, bytes: await pdf("Deposit slip"), originalName: "deposit.pdf" });
    const internal = await staffUploadDocument(s.tabitha, { clientId: s.biz.id, category: "OTHER", title: "Office notes on the deposit", visibility: "STAFF_ONLY", bytes: await pdf("internal"), originalName: "notes.pdf", notify: false });
    const draftReport = await staffUploadDocument(s.tabitha, { clientId: s.biz.id, category: "BOOKKEEPING", title: "March P&L (draft)", visibility: "STAFF_ONLY", reportType: "PROFIT_AND_LOSS", bytes: await pdf("pnl"), originalName: "pnl.pdf", notify: false });
    await prisma.document.updateMany({ where: { id: { in: [internal.id, draftReport.id] } }, data: { scanStatus: "CLEAN" } });

    expect((await vault(s, s.owner)).map((d) => d.id)).toEqual([doc.id]);
    expect(await vault(s, s.helper)).toEqual([]);
    const open = (who: { id: string }, id: string) => authorizeDownload(downloadToken(id, { portalUserId: who.id }), { portalUserId: who.id });
    expect(await open(s.helper, doc.id)).toBeNull();
    for (const id of [internal.id, draftReport.id]) expect(await open(s.owner, id)).toBeNull();
  });
});
