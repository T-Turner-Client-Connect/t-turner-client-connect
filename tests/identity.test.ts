import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { authorizeDownload, downloadToken, portalDocuments } from "@/lib/services/documents";
import { notificationText } from "@/lib/services/notifications";
import {
  addPerson, ensureClientPerson, identityAlerts, identityChecklist, maskedSsn, portalIdentityOverview, rejectIdentityDocument, runIdentityReminders, staffIdentityOverview, uploadIdentityDocument, verifyIdentityDocument,
} from "@/lib/services/identity";
import { addDays, officeToday } from "@/lib/tax/deadlines";
import { updateStaffAlertSettings } from "@/lib/services/staff-alerts";
import { readDocumentBytes } from "@/lib/services/documents";
import { storage } from "@/lib/storage";
import { assertOwner } from "@/lib/auth/owner";
import { checklistText, setIdentityAccessAll } from "@/lib/services/identity";

let seq = 0;
const img = () => new TextEncoder().encode(`%PDF-1.4\n% fictional id ${seq++}\n`);

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const tab = await makeUser("ADMIN");
  const c = await createClient(tab, { firstName: "Ana", lastName: "Diaz", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const { token } = await invitePortalUser(tab, c.id, { email: "ana@example.com", name: "Ana", role: "OWNER" });
  const u = await acceptPortalInvite(token!, "Client-Pass-1234");
  const user = { id: u.id, name: u.name, email: u.email };
  const me = await ensureClientPerson(c.id);
  return { tab, client: c, user, me };
}

const inDays = (n: number) => addDays(officeToday(), n);

describe("identity documents", () => {
  it("stay pending until staff verify; a replacement keeps history and one current document", async () => {
    const { tab, client, user, me } = await setup();
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "TTurner & Associates <alerts@mail.example.com>");
    await updateStaffAlertSettings(tab, { smsEnabled: false, phone: "205-659-5448", windowStart: "08:00", windowEnd: "17:00", emailEnabled: true, email: "info@tturnerassociates.com" });
    await expect(uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "DRIVERS_LICENSE", bytes: img(), originalName: "dl.pdf" })).rejects.toThrow(/expiration date/);
    await expect(uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "DRIVERS_LICENSE", expiresOn: inDays(-1), bytes: img(), originalName: "dl.pdf" })).rejects.toThrow(/already expired/);
    const first = await uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "DRIVERS_LICENSE", expiresOn: inDays(400), bytes: img(), originalName: "dl.pdf" });
    expect(first.status).toBe("PENDING_VERIFICATION");
    expect(await prisma.staffAlert.count()).toBeGreaterThan(0); // office told about the upload
    // Not in the yearly folders.
    expect((await portalDocuments(user, client.id)).some((d) => d.id === first.documentId)).toBe(false);

    await verifyIdentityDocument(tab, first.id, {});
    // A second upload of the same kind needs a reason and doesn't replace the current one until verified.
    await expect(uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "DRIVERS_LICENSE", expiresOn: inDays(1500), bytes: img(), originalName: "dl2.pdf" })).rejects.toThrow(/why you're replacing/);
    const second = await uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "DRIVERS_LICENSE", expiresOn: inDays(1500), replacementReason: "Renewed license", bytes: img(), originalName: "dl2.pdf" });
    let slot = (await portalIdentityOverview(user, client.id))[0].slots.find((s) => s.type === "DRIVERS_LICENSE")!;
    expect(slot.current!.id).toBe(first.id);
    expect(slot.pending.map((p) => p.id)).toEqual([second.id]);
    await verifyIdentityDocument(tab, second.id, {});
    slot = (await portalIdentityOverview(user, client.id))[0].slots.find((s) => s.type === "DRIVERS_LICENSE")!;
    expect(slot.current!.id).toBe(second.id);
    expect(slot.history.map((h) => h.status)).toEqual(["VERIFIED", "REPLACED"]);
  });

  it("birth certificates and Social Security cards never get an expiration; SSNs are masked to the last four", async () => {
    const { tab, client, user, me } = await setup();
    const kid = await addPerson({ portal: user }, client.id, { role: "DEPENDENT", name: "Leo Diaz" });
    const bc = await uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: kid.id, type: "BIRTH_CERTIFICATE", expiresOn: "2030-01-01", bytes: img(), originalName: "bc.pdf" });
    expect(bc.expiresOn).toBeNull();
    const ss = await uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "SOCIAL_SECURITY_CARD", bytes: img(), originalName: "ss.pdf" });
    await expect(verifyIdentityDocument(tab, ss.id, { last4: "123456789" })).rejects.toThrow(/last four/);
    await verifyIdentityDocument(tab, ss.id, { last4: "6789" });
    const row = await prisma.identityDocument.findUniqueOrThrow({ where: { id: ss.id } });
    expect(row.last4).toBe("6789");
    expect(maskedSsn(row.last4)).toBe("•••-••-6789");
    // Checklists point at the stored file; nothing is copied.
    const before = await prisma.document.count();
    const list = await identityChecklist(client.id);
    expect(list.find((p) => p.person.id === me.id)!.items.find((i) => i.type === "SOCIAL_SECURITY_CARD")).toMatchObject({ state: "ON_FILE", documentId: ss.documentId });
    expect(list.find((p) => p.person.id === kid.id)!.items.find((i) => i.type === "BIRTH_CERTIFICATE")!.state).toBe("PENDING");
    expect(await prisma.document.count()).toBe(before);
    // Declined uploads tell the client generically.
    await rejectIdentityDocument(tab, bc.id, "Image is cut off");
    expect(identityAlerts(await portalIdentityOverview(user, client.id)).some((a) => /cut off/.test(a.text))).toBe(true);
  });

  it("license reminders at 60, 30 and 7 days are sent once each and say nothing identifying; then Expired", async () => {
    vi.stubEnv("NOTIFICATIONS_ENABLED", "false");
    const { tab, client, user, me } = await setup();
    const l = await uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "DRIVERS_LICENSE", expiresOn: inDays(90), bytes: img(), originalName: "dl.pdf" });
    await verifyIdentityDocument(tab, l.id, {});
    const at = (days: number) => new Date(Date.now() + days * 86400_000);
    expect(await runIdentityReminders(at(10))).toEqual({ reminded: 0, expired: 0 }); // 80 days left
    expect((await runIdentityReminders(at(31))).reminded).toBe(1); // 59 left → 60-day notice
    expect((await runIdentityReminders(at(32))).reminded).toBe(0); // not repeated
    expect((await runIdentityReminders(at(61))).reminded).toBe(1); // 30-day
    expect((await runIdentityReminders(at(84))).reminded).toBe(1); // 7-day
    expect((await runIdentityReminders(at(91))).expired).toBe(1);
    expect((await prisma.identityDocument.findUniqueOrThrow({ where: { id: l.id } })).status).toBe("EXPIRED");
    const kinds = (await prisma.notification.findMany()).map((n) => n.kind);
    expect(kinds.filter((k) => k === "ID_EXPIRING")).toHaveLength(3); // email only (no SMS opt-in)
    expect(kinds).toContain("ID_EXPIRED");
    for (const k of ["ID_EXPIRING", "ID_EXPIRED", "ID_NEEDS_ATTENTION"]) {
      const t = notificationText(k);
      expect(`${t.subject} ${t.body} ${t.sms}`).not.toMatch(/license|social security|birth|Ana|Diaz/i);
    }
  });

  it("a late upload gets a single reminder, and a pending replacement pauses reminders", async () => {
    vi.stubEnv("NOTIFICATIONS_ENABLED", "false");
    const { tab, client, user, me } = await setup();
    const l = await uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "DRIVERS_LICENSE", expiresOn: inDays(20), bytes: img(), originalName: "dl.pdf" });
    await verifyIdentityDocument(tab, l.id, {});
    expect((await runIdentityReminders()).reminded).toBe(1);
    expect((await prisma.identityDocument.findUniqueOrThrow({ where: { id: l.id } })).remindersSent.sort()).toEqual(["30", "60"]);
    await uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "DRIVERS_LICENSE", expiresOn: inDays(1400), replacementReason: "Renewed license", bytes: img(), originalName: "new.pdf" });
    expect((await runIdentityReminders(new Date(Date.now() + 15 * 86400_000))).reminded).toBe(0);
  });

  it("Social Security cards and birth certificates open only for Admins — never assigned staff or any portal user", async () => {
    const { tab, client, user, me } = await setup();
    const kid = await addPerson({ portal: user }, client.id, { role: "DEPENDENT", name: "Leo Diaz" });
    const ss = await uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "SOCIAL_SECURITY_CARD", bytes: img(), originalName: "ss.pdf" });
    const bc = await uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: kid.id, type: "BIRTH_CERTIFICATE", bytes: img(), originalName: "bc.pdf" });
    const dl = await uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "DRIVERS_LICENSE", expiresOn: inDays(400), bytes: img(), originalName: "dl.pdf" });
    const open = (docId: string, v: { staffId?: string; portalUserId?: string }) => authorizeDownload(downloadToken(docId, v), v);

    // The uploading client (account owner with identity access) can't retrieve them with a direct link.
    expect(await open(ss.documentId, { portalUserId: user.id })).toBeNull();
    expect(await open(bc.documentId, { portalUserId: user.id })).toBeNull();
    expect(await open(dl.documentId, { portalUserId: user.id })).not.toBeNull(); // licenses unchanged
    // Neither can a bookkeeper/authorized contact, even when given identity access.
    const { token } = await invitePortalUser(tab, client.id, { email: "bookkeeper@example.com", name: "Bo", role: "AUTHORIZED_CONTACT" });
    const bo = await acceptPortalInvite(token!, "Client-Pass-5678");
    await prisma.portalAccess.updateMany({ where: { portalUserId: bo.id }, data: { canViewIdentity: true } });
    expect(await open(ss.documentId, { portalUserId: bo.id })).toBeNull();
    expect(await open(bc.documentId, { portalUserId: bo.id })).toBeNull();

    // Assigned staff — and staff granted identity access for all clients — are refused; only Admins open them.
    const daria = await makeUser("STAFF");
    await prisma.client.update({ where: { id: client.id }, data: { assignedToId: daria.id } });
    await setIdentityAccessAll(tab, daria.id, true);
    expect(await open(ss.documentId, { staffId: daria.id })).toBeNull();
    expect(await open(bc.documentId, { staffId: daria.id })).toBeNull();
    expect(await open(dl.documentId, { staffId: daria.id })).not.toBeNull();
    await expect(verifyIdentityDocument(daria, ss.id, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(rejectIdentityDocument(daria, bc.id, "x")).rejects.toBeInstanceOf(ForbiddenError);
    expect(await open(ss.documentId, { staffId: tab.id })).not.toBeNull();
    expect(await open(bc.documentId, { staffId: tab.id })).not.toBeNull();
    // A deactivated Admin can't.
    await prisma.user.update({ where: { id: tab.id }, data: { active: false } });
    expect(await open(ss.documentId, { staffId: tab.id })).toBeNull();
    await prisma.user.update({ where: { id: tab.id }, data: { active: true } });

    // Clients still upload replacements and see status — and never another client's records.
    const other = await createClient(tab, { firstName: "Zed", lastName: "Z", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const zedPerson = await ensureClientPerson(other.id);
    await expect(uploadIdentityDocument({ portal: user }, { clientId: other.id, personId: zedPerson.id, type: "BIRTH_CERTIFICATE", bytes: img(), originalName: "x.pdf" })).rejects.toBeInstanceOf(ForbiddenError);
    await verifyIdentityDocument(tab, ss.id, { last4: "6789" });
    const slot = (await portalIdentityOverview(user, client.id))[0].slots.find((x) => x.type === "SOCIAL_SECURITY_CARD")!;
    expect(slot.current!.status).toBe("VERIFIED");
    await expect(uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "SOCIAL_SECURITY_CARD", replacementReason: "Name change", bytes: img(), originalName: "ss2.pdf" })).resolves.toBeTruthy();
    // Kept out of yearly lists and message attachments.
    expect((await portalDocuments(user, client.id)).some((d) => d.category === "IDENTITY")).toBe(false);
  });

  it("are encrypted before storage and still open for authorized viewers", async () => {
    const { client, user, me } = await setup();
    const bytes = img();
    const ss = await uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "SOCIAL_SECURITY_CARD", bytes, originalName: "ss.pdf" });
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: ss.documentId }, include: { file: true } });
    expect(doc.file.encrypted).toBe(true);
    const raw = await storage.get(doc.file.storageKey);
    expect(Buffer.from(raw!).subarray(0, 4).toString()).toBe("TCE1");
    expect(Buffer.from(raw!).includes(Buffer.from("fictional id"))).toBe(false);
    expect(Buffer.from((await readDocumentBytes(doc.file))!).equals(Buffer.from(bytes))).toBe(true);
  });

  it("each upload opens a staff verification task that closes on verify or decline", async () => {
    const { tab, client, user, me } = await setup();
    const daria = await makeUser("STAFF");
    await prisma.client.update({ where: { id: client.id }, data: { assignedToId: daria.id } });
    const l = await uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "DRIVERS_LICENSE", expiresOn: inDays(300), bytes: img(), originalName: "dl.pdf" });
    await verifyIdentityDocument(tab, l.id, {});
    const r = await uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "DRIVERS_LICENSE", expiresOn: inDays(1500), replacementReason: "Renewed license", bytes: img(), originalName: "dl2.pdf" });
    const task = await prisma.task.findUniqueOrThrow({ where: { id: (await prisma.identityDocument.findUniqueOrThrow({ where: { id: r.id } })).verificationTaskId! } });
    expect(task).toMatchObject({ status: "OPEN", assigneeId: daria.id, clientId: client.id, priority: "HIGH" });
    expect(task.title).toBe("Verify replacement driver's license — Ana Diaz");
    await rejectIdentityDocument(tab, r.id, "Blurry");
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("DONE");
  });

  it("a pending or declined replacement never hides that the license on file expired", async () => {
    vi.stubEnv("NOTIFICATIONS_ENABLED", "false");
    const { tab, client, user, me } = await setup();
    const l = await uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "DRIVERS_LICENSE", expiresOn: inDays(3), bytes: img(), originalName: "dl.pdf" });
    await verifyIdentityDocument(tab, l.id, {});
    const r = await uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "DRIVERS_LICENSE", expiresOn: inDays(1500), replacementReason: "Renewed license", bytes: img(), originalName: "dl2.pdf" });
    expect((await runIdentityReminders(new Date(Date.now() + 5 * 86400_000))).expired).toBe(1);
    let ov = await portalIdentityOverview(user, client.id);
    expect(ov[0].slots.find((s) => s.type === "DRIVERS_LICENSE")!.current!.status).toBe("EXPIRED");
    expect(identityAlerts(ov).some((a) => /has expired\. Your renewed license was received/.test(a.text))).toBe(true);
    let item = (await identityChecklist(client.id))[0].items.find((i) => i.type === "DRIVERS_LICENSE")!;
    expect(checklistText(item)).toBe("Expired — replacement awaiting verification");
    await rejectIdentityDocument(tab, r.id, "Wrong document");
    ov = await portalIdentityOverview(user, client.id);
    expect(identityAlerts(ov).some((a) => /has expired\. Please upload the renewed license/.test(a.text))).toBe(true);
    item = (await identityChecklist(client.id))[0].items.find((i) => i.type === "DRIVERS_LICENSE")!;
    expect(item.state).toBe("EXPIRED");
  });

  it("an Admin can grant a staff member license access for all clients without opening the Owner's Office", async () => {
    const { tab, client, user, me } = await setup();
    const dl = await uploadIdentityDocument({ portal: user }, { clientId: client.id, personId: me.id, type: "DRIVERS_LICENSE", expiresOn: inDays(400), bytes: img(), originalName: "dl.pdf" });
    const daria = await makeUser("STAFF");
    const other = await makeUser("STAFF", "Other");
    await expect(setIdentityAccessAll(other, daria.id, true)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await authorizeDownload(downloadToken(dl.documentId, { staffId: daria.id }), { staffId: daria.id })).toBeNull();
    await setIdentityAccessAll(tab, daria.id, true);
    expect(await authorizeDownload(downloadToken(dl.documentId, { staffId: daria.id }), { staffId: daria.id })).not.toBeNull();
    expect((await staffIdentityOverview(daria, client.id)).length).toBeGreaterThan(0);
    await expect(assertOwner(daria)).rejects.toThrow();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: daria.id } })).role).toBe("STAFF");
    await setIdentityAccessAll(tab, daria.id, false);
    expect(await authorizeDownload(downloadToken(dl.documentId, { staffId: daria.id }), { staffId: daria.id })).toBeNull();
  });
});
