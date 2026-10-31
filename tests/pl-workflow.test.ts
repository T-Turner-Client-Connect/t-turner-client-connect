import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { bookkeepingWorkspace, saveProfile, STAGES, workMonth } from "@/lib/services/bookkeeping-clients";
import { askClientQuestion, autoOpenWorkMonth, resolveQuestion, reviseTarget } from "@/lib/services/bookkeeping-questions";
import { openPeriod } from "@/lib/services/bookkeeping";
import { portalSendMessage } from "@/lib/services/messaging";

const sent: { to: string; subject: string; html: string; text: string }[] = [];
beforeEach(async () => {
  await resetDb();
  sent.length = 0;
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    // A stand-in for the email provider (local test only — not live delivery).
    if (String(url).includes("/emails")) {
      const b = JSON.parse(String(init?.body ?? "{}"));
      sent.push({ to: Array.isArray(b.to) ? b.to[0] : b.to, subject: b.subject, html: b.html ?? "", text: b.text ?? "" });
      return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
    }
    return new Response(JSON.stringify({ clean: true }), { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const day = (d: Date | null | undefined) => d?.toISOString().slice(0, 10);

describe("monthly P&L workflow", () => {
  it("uses the office's stage names", () => {
    expect([STAGES.CLIENT_DOCUMENTS.label, STAGES.STAFF_WORK.label, STAGES.WAITING_ON_CLIENT.label, STAGES.AWAITING_REVIEW.label, STAGES.READY_TO_DELIVER.label, STAGES.DELIVERED.label]).toEqual([
      "Collecting Documents", "In Progress", "Waiting on Client", "Awaiting Tabitha Review", "Ready to Deliver", "Delivered",
    ]);
  });

  it("works the previous month by the Chicago calendar — starting on the 1st", () => {
    expect(workMonth("MONTHLY", new Date("2026-11-01T05:30:00Z"))).toEqual({ year: 2026, month: 10 }); // Nov 1, 12:30 a.m. Chicago
    expect(workMonth("MONTHLY", new Date("2026-11-01T04:30:00Z"))).toEqual({ year: 2026, month: 9 }); // still Oct 31 in Chicago
    expect(workMonth("MONTHLY", new Date("2027-01-01T12:00:00Z"))).toEqual({ year: 2026, month: 12 });
  });

  it("targets the 15th with Tabitha's review before it; questions put the month on Waiting on Client; revisions never replace the original", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const daria = await makeUser("STAFF", "Daria");
    const biz = await createClient(tabitha, { businessName: "Fictional Florist LLC", clientType: "BUSINESS", status: "ACTIVE" });
    await prisma.client.update({ where: { id: biz.id }, data: { assignedToId: daria.id } });
    await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false });
    const period = await openPeriod(tabitha, biz.id, 2026, 9);
    let ws = await bookkeepingWorkspace(biz.id, period.id);
    expect(day(ws.summary!.due.reports)).toBe("2026-10-15");
    expect(ws.summary!.due.review).toBeNull(); // no review date unless Tabitha sets one
    await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false, reviewDueDay: 12 });
    ws = await bookkeepingWorkspace(biz.id, period.id);
    expect(day(ws.summary!.due.review)).toBe("2026-10-12");

    // The client's login exists before the question, so they're notified.
    const { token } = await invitePortalUser(tabitha, biz.id, { email: "owner@fictional.example", name: "Pat Owner", role: "OWNER" });
    const login = await acceptPortalInvite(token!, "Owner-Pass-12345");
    vi.stubEnv("NOTIFICATIONS_ENABLED", "true");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "TTurner & Associates <info@tturnerassociates.com>");

    // Ask a question → Waiting on Client, flagged immediately.
    const qid = await askClientQuestion(daria, biz.id, period.id, { subject: "$1,240 deposit on Sept 4", body: "What was this deposit for?", dueOn: "2099-01-10" });
    ws = await bookkeepingWorkspace(biz.id, period.id);
    expect(ws.summary!.stage).toBe("WAITING_ON_CLIENT");
    expect(ws.summary!.flags).toContain("1 question waiting on the client");
    // Tied to this business and month; the client is notified with a sign-in link, not the content.
    const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: qid }, include: { messages: true } });
    expect([convo.clientId, convo.periodId]).toEqual([biz.id, period.id]);
    const note = await prisma.notification.findFirstOrThrow({ where: { portalUserId: login.id, kind: "NEW_MESSAGE" } });
    expect(note.idempotencyKey).toContain(convo.messages[0].id);
    expect(note.status).toBe("SENT");
    expect(sent.at(-1)?.to).toBe("owner@fictional.example");
    expect(sent.at(-1)?.text).not.toContain("What was this deposit for?");
    expect(sent.at(-1)?.text).toMatch(/https?:\/\/\S+/);

    // The client answers in the portal → Answered; the assigned staff member gets a task. Not resolved by the reply.
    await portalSendMessage({ id: login.id, name: login.name, email: login.email }, { clientId: biz.id, conversationId: qid, body: "Customer refund from Bloom Co." });
    const q = await prisma.conversation.findUniqueOrThrow({ where: { id: qid } });
    expect(q.questionStatus).toBe("ANSWERED");
    expect(await prisma.task.count({ where: { clientId: biz.id, assigneeId: daria.id, title: { contains: "answered" } } })).toBe(1);
    ws = await bookkeepingWorkspace(biz.id, period.id);
    expect(ws.summary!.stage).not.toBe("WAITING_ON_CLIENT");
    expect(ws.summary!.flags).toContain("1 answer to review");
    await resolveQuestion(daria, biz.id, qid);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: qid } })).questionStatus).toBe("RESOLVED");

    // A revised estimate is recorded beside the original target.
    await expect(reviseTarget(daria, biz.id, period.id, { targetOn: "2099-01-20", reason: "x" })).rejects.toThrow(/Say why/);
    await reviseTarget(daria, biz.id, period.id, { targetOn: "2099-01-20", reason: "Waiting on the September card statement" });
    ws = await bookkeepingWorkspace(biz.id, period.id);
    expect(day(ws.summary!.due.reports)).toBe("2026-10-15"); // original unchanged
    expect(day(ws.summary!.due.revised)).toBe("2099-01-20");
    expect(ws.summary!.revisions).toHaveLength(1);
  });

  it("opens the work month for every client once, on the 1st", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    for (const n of ["A Co (fictional)", "B Co (fictional)"]) {
      const c = await createClient(tabitha, { businessName: n, clientType: "BUSINESS", status: "ACTIVE" });
      await saveProfile(tabitha, c.id, { active: true, frequency: n.startsWith("A") ? "MONTHLY" : "QUARTERLY", payroll: false });
    }
    const first = await autoOpenWorkMonth(new Date("2026-11-01T12:00:00Z"));
    expect(first).toMatchObject({ opened: 2, month: "2026-10", skipped: false });
    expect(await autoOpenWorkMonth(new Date("2026-11-01T12:10:00Z"))).toMatchObject({ skipped: true });
    expect(await prisma.bookkeepingPeriod.count({ where: { year: 2026, month: 10 } })).toBe(2); // quarterly clients still collect monthly
  });
});
