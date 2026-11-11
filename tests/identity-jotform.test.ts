import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { authorizeDownload, downloadToken, staffUploadDocument } from "@/lib/services/documents";
import { linkSubmission, taxYearStatuses } from "@/lib/services/tax-center";
import { addPerson, ensureClientPerson, identityCompletion, moveIdentityDocument, removeIdentityDocument, verifyIdentityDocument, identityOverview, ipPinStatus, revealIpPin, saveIpPin, setHasIpPin, uploadIdentityDocument } from "@/lib/services/identity";
import { classifyIdQuestion, fileQuestionnaireUploadByHand, moveQuestionnaireIdentity, spouseNameFrom } from "@/lib/services/identity-import";

// Fictional clients, people and files only. A fake Jotform API serves the submissions and files.
let seq = 0;
const png = () => {
  const b = new Uint8Array(80);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b[40] = seq++ % 256; b[41] = Math.floor(seq / 256);
  return b;
};
const submissions: Record<string, unknown> = {};
async function jotformFetch(url: string | URL) {
  const u = String(url);
  if (u.includes("scanner.test")) return new Response(JSON.stringify({ clean: true }), { status: 200 });
  const m = /\/submission\/(\d+)$/.exec(u);
  if (m) return submissions[m[1]] ? new Response(JSON.stringify({ content: submissions[m[1]] }), { status: 200 }) : new Response("{}", { status: 404 });
  if (u.startsWith("https://www.jotform.com/uploads/")) return new Response(png(), { status: 200 });
  return new Response("not found", { status: 404 });
}
beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubEnv("JOTFORM_API_KEY", "jf_key");
  vi.stubGlobal("fetch", jotformFetch);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const up = (q: string, file: string) => ({ type: "control_fileupload", text: q, answer: [`https://www.jotform.com/uploads/x/${file}`] });

async function setup() {
  const admin = await makeUser("ADMIN", "Tabitha");
  const staff = await makeUser("STAFF", "Daria");
  const client = await createClient(admin, { firstName: "Rowan", lastName: "Example", clientType: "INDIVIDUAL", status: "ACTIVE", email: "rowan@fictional.example", assignedToId: staff.id });
  const { token } = await invitePortalUser(admin, client.id, { email: "rowan@fictional.example", name: "Rowan Example", role: "OWNER" });
  const login = await acceptPortalInvite(token!, "Client-Pass-12345");
  await prisma.portalAccess.updateMany({ where: { clientId: client.id }, data: { canViewIdentity: true } });
  return { admin, staff, client, login };
}

describe("ID documents from Jotform questionnaires go into Identity Documents", () => {
  it("recognizes the document and whose it is from the question; reads the spouse's name", () => {
    expect(classifyIdQuestion("Upload your Driver's License (front)")).toEqual({ type: "DRIVERS_LICENSE", role: "CLIENT" });
    expect(classifyIdQuestion("Spouse Birth Certificate")).toEqual({ type: "BIRTH_CERTIFICATE", role: "SPOUSE" });
    expect(classifyIdQuestion("Dependent's Social Security card")).toEqual({ type: "SOCIAL_SECURITY_CARD", role: "DEPENDENT" });
    expect(classifyIdQuestion("Passport (if you have one)")).toEqual({ type: "PASSPORT", role: "CLIENT" });
    expect(classifyIdQuestion("W-2 forms")).toBeNull();
    expect(spouseNameFrom([{ q: "Spouse full name", a: "Jordan  Example" }, { q: "Spouse employer name", a: "Acme" }])).toBe("Jordan Example");
  });

  it("a new pull: ID uploads are filed into Identity (one record, encrypted, pending), the spouse is added, other uploads stay in taxes, and the portal can't open any of them", async () => {
    const s = await setup();
    submissions["7770001110001"] = { id: "7770001110001", form_id: "241234567890123", created_at: "2026-02-10 10:00:00", answers: {
      1: { type: "control_email", text: "Email", answer: "rowan@fictional.example" },
      2: { type: "control_fullname", text: "Spouse full name", answer: { first: "Jordan", last: "Example" }, prettyFormat: "Jordan Example" },
      3: up("Upload your driver's license", "dl-2026.png"),
      4: up("Spouse birth certificate", "spouse-bc.png"),
      5: up("W-2 forms", "w2.png"),
    } };
    const before = await prisma.document.count();
    const r = await linkSubmission(s.staff, { clientId: s.client.id, taxYear: 2025, submissionId: "7770001110001", confirmed: false });
    expect(r.imported).toBe(3);
    expect(await prisma.document.count()).toBe(before + 3); // one record per file, nothing copied

    const ids = await prisma.identityDocument.findMany({ where: { clientId: s.client.id }, include: { person: true } });
    expect(ids.map((i) => [i.type, i.person.role, i.status]).sort()).toEqual([["BIRTH_CERTIFICATE", "SPOUSE", "PENDING_VERIFICATION"], ["DRIVERS_LICENSE", "CLIENT", "PENDING_VERIFICATION"]]);
    expect(ids.find((i) => i.person.role === "SPOUSE")!.person.name).toBe("Jordan Example");
    for (const i of ids) {
      const d = await prisma.document.findUniqueOrThrow({ where: { id: i.documentId }, include: { file: true } });
      expect(d.category).toBe("IDENTITY");
      expect(d.file!.encrypted).toBe(true);
    }
    expect(await prisma.task.count({ where: { clientId: s.client.id, title: { startsWith: "Verify" } } })).toBe(2);
    const w2 = await prisma.document.findFirstOrThrow({ where: { clientId: s.client.id, docType: "QUESTIONNAIRE_UPLOAD" } });
    expect(w2.category).toBe("TAXES");

    // Who can open them: the assigned staff member opens the license; only an Admin opens the birth
    // certificate; the client's portal login opens neither.
    const dl = ids.find((i) => i.type === "DRIVERS_LICENSE")!;
    const bc = ids.find((i) => i.type === "BIRTH_CERTIFICATE")!;
    const staffOpen = (id: string, staffId: string) => authorizeDownload(downloadToken(id, { staffId }), { staffId });
    expect(await staffOpen(dl.documentId, s.staff.id)).not.toBeNull();
    expect(await staffOpen(bc.documentId, s.staff.id)).toBeNull();
    expect(await staffOpen(bc.documentId, s.admin.id)).not.toBeNull();
    for (const id of [dl.documentId, bc.documentId]) expect(await authorizeDownload(downloadToken(id, { portalUserId: s.login.id }), { portalUserId: s.login.id })).toBeNull();
  });

  it("questionnaires already pulled over: one button files them, the most recent license is the one on file, a passport shows only when there is one", async () => {
    const s = await setup();
    // Pulled over before this change: the questions didn't say, so everything stayed in taxes.
    submissions["7770002220001"] = { id: "7770002220001", form_id: "241234567890123", created_at: "2025-02-01 09:00:00", answers: { 1: { type: "control_email", answer: "rowan@fictional.example" }, 2: up("Upload 1", "dl-2025.png") } };
    submissions["7770002220002"] = { id: "7770002220002", form_id: "241234567890123", created_at: "2026-02-01 09:00:00", answers: { 1: { type: "control_email", answer: "rowan@fictional.example" }, 2: up("Upload 1", "dl-2026.png"), 3: up("Upload 2", "passport.png"), 4: up("Upload 3", "receipt.png") } };
    await linkSubmission(s.staff, { clientId: s.client.id, taxYear: 2024, submissionId: "7770002220001", confirmed: false });
    await linkSubmission(s.staff, { clientId: s.client.id, taxYear: 2025, submissionId: "7770002220002", confirmed: false });
    expect(await prisma.identityDocument.count()).toBe(0);
    // Before: no passport slot (it's optional, never "missing").
    expect((await identityOverview(s.client.id))[0].slots.map((x) => x.type)).not.toContain("PASSPORT");

    // Jotform's questions (as the real form words them).
    (submissions["7770002220001"] as { answers: Record<string, unknown> }).answers[2] = up("Driver's license", "dl-2025.png");
    Object.assign((submissions["7770002220002"] as { answers: Record<string, unknown> }).answers, { 2: up("Driver's license", "dl-2026.png"), 3: up("Passport", "passport.png") });
    const r = await moveQuestionnaireIdentity(s.staff, s.client.id);
    expect(r.filed).toHaveLength(3);
    expect(r.unrecognized).toBe(1); // the receipt stays in taxes

    const licenses = await prisma.identityDocument.findMany({ where: { clientId: s.client.id, type: "DRIVERS_LICENSE" }, orderBy: { createdAt: "asc" } });
    expect(licenses.map((l) => l.status)).toEqual(["REPLACED", "PENDING_VERIFICATION"]); // 2025 history, 2026 on file
    const slots = (await identityOverview(s.client.id))[0].slots;
    expect(slots.map((x) => x.type)).toContain("PASSPORT");
    expect(slots.find((x) => x.type === "DRIVERS_LICENSE")!.pending).toHaveLength(1);
    // Running it again files nothing twice.
    expect((await moveQuestionnaireIdentity(s.staff, s.client.id)).filed).toHaveLength(0);

    // The receipt can be filed by hand if it were an ID; a stranger can't.
    const receipt = await prisma.document.findFirstOrThrow({ where: { clientId: s.client.id, docType: "QUESTIONNAIRE_UPLOAD" } });
    const stranger = await makeUser("STAFF", "Morgan");
    const me = (await identityOverview(s.client.id))[0].person;
    await expect(fileQuestionnaireUploadByHand(stranger, s.client.id, receipt.id, { type: "BIRTH_CERTIFICATE", personId: me.id })).rejects.toThrow(/Admin or the client's assigned staff/);
    await fileQuestionnaireUploadByHand(s.staff, s.client.id, receipt.id, { type: "BIRTH_CERTIFICATE", personId: me.id });
    expect(await prisma.identityDocument.count({ where: { clientId: s.client.id, type: "BIRTH_CERTIFICATE" } })).toBe(1);
  });
});

describe("IRS IP PIN, Completed, and missing items", () => {
  it("the IP PIN is optional: only people who have one need this year's; it's saved encrypted, staff view it (logged), the client can't read it back", async () => {
    const s = await setup();
    const me = (await identityOverview(s.client.id))[0].person;
    // No IP PIN: not counted.
    let c = identityCompletion(await identityOverview(s.client.id), await ipPinStatus(s.client.id));
    expect(c.missing.some((m) => /IP PIN/.test(m))).toBe(false);
    // Has one: this year's is needed until it's added.
    await setHasIpPin({ portal: s.login }, s.client.id, me.id, true);
    c = identityCompletion(await identityOverview(s.client.id), await ipPinStatus(s.client.id));
    expect(c.missing.some((m) => /IP PIN/.test(m))).toBe(true);
    await expect(saveIpPin({ portal: s.login }, s.client.id, me.id, "12345")).rejects.toThrow(/6 digits/);
    await saveIpPin({ portal: s.login }, s.client.id, me.id, "482 913");
    const row = await prisma.identityPin.findFirstOrThrow({ where: { personId: me.id } });
    expect(row.pinEnc).not.toContain("482913");
    expect(await revealIpPin(s.staff, s.client.id, me.id)).toBe("482913");
    expect(await prisma.auditLog.count({ where: { action: "identity.ip_pin_viewed", clientId: s.client.id } })).toBe(1);
    const stranger = await makeUser("STAFF", "Morgan");
    await expect(revealIpPin(stranger, s.client.id, me.id)).rejects.toThrow();
    c = identityCompletion(await identityOverview(s.client.id), await ipPinStatus(s.client.id));
    expect(c.missing.some((m) => /IP PIN/.test(m))).toBe(false);
  });

  it("Completed only once every required document is received; a questionnaire with gaps opens a staff task (no client notice until communications are authorized)", async () => {
    const s = await setup();
    submissions["7770003330001"] = { id: "7770003330001", form_id: "241234567890123", created_at: "2026-02-10 10:00:00", answers: { 1: { type: "control_email", answer: "rowan@fictional.example" }, 2: up("Driver's license", "dl.png") } };
    await linkSubmission(s.staff, { clientId: s.client.id, taxYear: 2025, submissionId: "7770003330001", confirmed: false });
    const c = identityCompletion(await identityOverview(s.client.id), await ipPinStatus(s.client.id));
    expect(c.complete).toBe(false);
    expect(c.missing).toEqual(["Rowan Example's social security card"]); // license received (pending); birth certificate only asked for dependents
    expect(await prisma.task.count({ where: { clientId: s.client.id, title: { startsWith: "Identity documents still needed" } } })).toBe(1);
    expect(await prisma.notification.count({ where: { kind: "ID_NEEDS_ATTENTION" } })).toBe(0);
  });

  it("the 2026 questionnaire isn't finished until the missing identity documents are uploaded (2025 and earlier unchanged)", async () => {
    const s = await setup();
    submissions["7770004440001"] = { id: "7770004440001", form_id: "241234567890123", created_at: "2026-11-10 10:00:00", answers: { 1: { type: "control_email", answer: "rowan@fictional.example" } } };
    submissions["7770004440002"] = { id: "7770004440002", form_id: "241234567890123", created_at: "2026-02-10 10:00:00", answers: { 1: { type: "control_email", answer: "rowan@fictional.example" } } };
    await linkSubmission(s.staff, { clientId: s.client.id, taxYear: 2026, submissionId: "7770004440001", confirmed: false });
    await linkSubmission(s.staff, { clientId: s.client.id, taxYear: 2025, submissionId: "7770004440002", confirmed: false });
    const [y26, y25] = await taxYearStatuses(s.client.id, [2026, 2025]);
    expect(y26.steps[0]).toMatchObject({ done: false });
    expect(y26.steps[0].value).toMatch(/Upload your missing identity documents to finish: .*driver's license/);
    expect(y25.steps[0]).toMatchObject({ value: "Completed", done: true });
  });

  it("uploading an ID that is already on file (e.g. a questionnaire upload) moves that copy into Identity instead of refusing it", async () => {
    const s = await setup();
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0x46, 0x41, 0x4b, 0x45, 0x0a]);
    const q = await staffUploadDocument(s.admin, { clientId: s.client.id, category: "TAXES", title: "2025 questionnaire upload — bc", year: 2025, visibility: "STAFF_ONLY", bytes, originalName: "bc.pdf", notify: false });
    const person = await ensureClientPerson(s.client.id);
    const rec = await uploadIdentityDocument({ staff: s.staff }, { clientId: s.client.id, personId: person.id, type: "BIRTH_CERTIFICATE", bytes, originalName: "bc (1).pdf" });
    expect(rec).toMatchObject({ documentId: q.id, type: "BIRTH_CERTIFICATE", status: "PENDING_VERIFICATION" });
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: q.id }, include: { file: true } });
    expect(doc).toMatchObject({ category: "IDENTITY", docType: "BIRTH_CERTIFICATE" });
    expect(doc.file.encrypted).toBe(true);
    expect(await prisma.document.count({ where: { clientId: s.client.id } })).toBe(1);
    // The same file again: already in Identity, said plainly.
    await expect(uploadIdentityDocument({ staff: s.staff }, { clientId: s.client.id, personId: person.id, type: "BIRTH_CERTIFICATE", bytes, originalName: "bc.pdf", replacementReason: "again" })).rejects.toThrow(/already in Identity Documents/);
  });

  it("a card filed on the wrong person moves to the right one (keeping its verification); Admins can remove a document, and the previous copy becomes current", async () => {
    const s = await setup();
    const parent = await ensureClientPerson(s.client.id);
    const child = await addPerson({ staff: s.admin }, s.client.id, { role: "DEPENDENT", name: "Demi Example" });
    const card = (n: number) => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, n, 0x0a]);
    const a = await uploadIdentityDocument({ staff: s.admin }, { clientId: s.client.id, personId: parent.id, type: "SOCIAL_SECURITY_CARD", bytes: card(1), originalName: "a.pdf" });
    await prisma.document.update({ where: { id: a.documentId }, data: { scanStatus: "CLEAN" } });
    await verifyIdentityDocument(s.admin, a.id, { last4: "0604" });
    const b = await uploadIdentityDocument({ staff: s.admin }, { clientId: s.client.id, personId: parent.id, type: "SOCIAL_SECURITY_CARD", bytes: card(2), originalName: "b.pdf", replacementReason: "questionnaire" });
    await prisma.document.update({ where: { id: b.documentId }, data: { scanStatus: "CLEAN" } });
    await verifyIdentityDocument(s.admin, b.id, { last4: "8890" });
    expect((await prisma.identityDocument.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("REPLACED");

    // The child's card (replaced on the parent) moves to the child and stays verified there.
    await expect(moveIdentityDocument(s.staff, a.id, child.id)).rejects.toThrow(); // Admin-only document
    await moveIdentityDocument(s.admin, a.id, child.id);
    expect(await prisma.identityDocument.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ personId: child.id, status: "VERIFIED" });
    expect((await prisma.identityDocument.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("VERIFIED");

    // Removing needs an Admin and a reason; the file goes to Recently deleted, the record leaves the list.
    await expect(removeIdentityDocument(s.staff, b.id, "wrong")).rejects.toThrow();
    await expect(removeIdentityDocument(s.admin, b.id, " ")).rejects.toThrow(/why/);
    await removeIdentityDocument(s.admin, b.id, "Filed by mistake (fictional)");
    expect((await prisma.document.findUniqueOrThrow({ where: { id: b.documentId } })).deletedAt).not.toBeNull();
    const ov = await identityOverview(s.client.id);
    const parentCard = ov.find((o) => o.person.id === parent.id)!.slots.find((x) => x.type === "SOCIAL_SECURITY_CARD")!;
    expect(parentCard.current).toBeNull();
    expect(parentCard.history).toHaveLength(0);
    expect(ov.find((o) => o.person.id === child.id)!.slots.find((x) => x.type === "SOCIAL_SECURITY_CARD")!.current?.id).toBe(a.id);
  });
});
