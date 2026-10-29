import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { acceptInvite, findOpenInvite } from "@/lib/services/users";
import {
  applyInviteEmailEvent,
  createPrivateInviteLink,
  inviteState,
  inviteStaff,
  recentInvites,
  resendInvite,
  revokeInvite,
  staffInvitationEmail,
} from "@/lib/services/staff-invitations";
import { resendSignatureFor, verifyResendSignature } from "@/lib/resend-webhook";
import { POST as resendWebhook } from "@/app/api/webhooks/resend/route";

type Sent = { url: string; headers: Record<string, string>; body: { from: string; to: string[]; subject: string; html: string; text: string; tags: { name: string; value: string }[] } };
let sent: Sent[] = [];
let reply: () => Response;
let n = 0;

const tokenFrom = (s: Sent) => s.body.text.match(/\/staff\/invite\/([A-Za-z0-9_-]+)/)![1];
const tokenOf = (link: string) => link.split("/staff/invite/")[1];

beforeEach(async () => {
  await resetDb();
  sent = [];
  reply = () => new Response(JSON.stringify({ id: `re_${++n}` }), { status: 200 });
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("EMAIL_FROM_ADDRESS", "T. Turner & Associates, LLC <invites@mail.example.com>");
  vi.stubEnv("APP_URL", "https://crm.example.com");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    await new Promise((r) => setTimeout(r, 5));
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return reply();
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("staff invitation emails", () => {
  it("emails a branded one-time link to the address entered and records provider acceptance", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    const out = await inviteStaff(tabitha, { email: "  Daria.New@Example.com ", name: "Daria", role: "STAFF" });
    expect(out.status).toBe("sent");
    expect(out.privateLink).toBeUndefined();
    expect(sent).toHaveLength(1);
    const mail = sent[0];
    expect(mail.url).toBe("https://api.resend.com/emails");
    expect(mail.body.to).toEqual(["daria.new@example.com"]);
    expect(mail.body.from).toContain("T. Turner & Associates, LLC");
    expect(mail.body.subject).toBe("Your staff invitation to TTurner Client Connect");
    expect(mail.body.html).toContain("Create Your Staff Account");
    expect(mail.body.html).toContain("T. Turner &amp; Associates, LLC");
    expect(mail.body.html).toContain("https://crm.example.com/staff/invite/");
    expect(mail.body.tags).toEqual([{ name: "category", value: "staff_invitation" }]);
    expect(mail.headers["Idempotency-Key"]).toBe(`staff-invite/${out.inviteId}`);

    const invite = await prisma.invite.findUniqueOrThrow({ where: { id: out.inviteId } });
    expect(invite.emailStatus).toBe("ACCEPTED");
    expect(invite.emailProviderId).toBe(`re_${n}`);
    expect(inviteState(invite)).toBe("ACCEPTED"); // not "Delivered" without provider confirmation
    expect(invite.expiresAt.getTime() - invite.createdAt.getTime()).toBeGreaterThan(7 * 24 * 3600e3 - 5000);
    // Only the hash is stored.
    expect(invite.tokenHash).not.toBe(tokenFrom(mail));
  });

  it("only Admins can invite, resend or revoke", async () => {
    const tabitha = await makeUser("ADMIN");
    const daria = await makeUser("STAFF");
    await expect(inviteStaff(daria, { email: "x@example.com", name: "X", role: "STAFF" })).rejects.toBeInstanceOf(ForbiddenError);
    const out = await inviteStaff(tabitha, { email: "x@example.com", name: "X", role: "STAFF" });
    await expect(resendInvite(daria, out.inviteId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(revokeInvite(daria, out.inviteId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createPrivateInviteLink(daria, out.inviteId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("prevents duplicate sends: double-submit, simultaneous submits, a second invite and rapid resends", async () => {
    const tabitha = await makeUser("ADMIN");
    const input = { email: "dup@example.com", name: "Dup", role: "STAFF" as const, idempotencyKey: "form-key-1" };
    const [a, b, c] = await Promise.all([inviteStaff(tabitha, input), inviteStaff(tabitha, input), inviteStaff(tabitha, input)]);
    expect([a, b, c].filter((o) => o.status === "sent")).toHaveLength(1);
    await inviteStaff(tabitha, input); // a later retry with the same key
    expect(sent).toHaveLength(1);
    expect(await prisma.invite.count()).toBe(1);

    await expect(inviteStaff(tabitha, { email: "DUP@example.com", name: "Dup", role: "STAFF" })).rejects.toThrow(/already has a pending invitation/);
    await expect(resendInvite(tabitha, a.inviteId || b.inviteId || c.inviteId)).rejects.toThrow(/less than a minute ago/);
    expect(sent).toHaveLength(1);

    // Two resends at once: one wins, one is refused; one new email.
    const id = (await prisma.invite.findFirstOrThrow()).id;
    await prisma.invite.update({ where: { id }, data: { emailAttemptAt: new Date(Date.now() - 120_000) } });
    const results = await Promise.allSettled([resendInvite(tabitha, id), resendInvite(tabitha, id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(await prisma.invite.count({ where: { revokedAt: null } })).toBe(1);
  });

  it("two Admins inviting the same address at once send one email", async () => {
    const tabitha = await makeUser("ADMIN");
    const other = await makeUser("ADMIN", "Second");
    const results = await Promise.allSettled([
      inviteStaff(tabitha, { email: "race@example.com", name: "Race", role: "STAFF", idempotencyKey: "tab-a" }),
      inviteStaff(other, { email: "race@example.com", name: "Race", role: "STAFF", idempotencyKey: "tab-b" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(await prisma.invite.count()).toBe(1);
  });

  it("resend replaces the link: the old one stops working, the new one works once", async () => {
    const tabitha = await makeUser("ADMIN");
    const first = await inviteStaff(tabitha, { email: "new@example.com", name: "New", role: "ADMIN" });
    const oldToken = tokenFrom(sent[0]);
    await prisma.invite.update({ where: { id: first.inviteId }, data: { emailAttemptAt: new Date(Date.now() - 120_000) } });
    const second = await resendInvite(tabitha, first.inviteId);
    expect(second.status).toBe("sent");
    const newToken = tokenFrom(sent[1]);
    expect(newToken).not.toBe(oldToken);
    expect(sent[1].headers["Idempotency-Key"]).toBe(`staff-invite/${second.inviteId}`);

    expect(await findOpenInvite(oldToken)).toBeNull();
    await expect(acceptInvite(oldToken, "a-strong-passphrase-1")).rejects.toThrow(/invalid or has expired/);
    const old = await prisma.invite.findUniqueOrThrow({ where: { id: first.inviteId } });
    expect(inviteState(old)).toBe("REPLACED");
    await expect(resendInvite(tabitha, first.inviteId)).rejects.toThrow(/already replaced/);

    const user = await acceptInvite(newToken, "a-strong-passphrase-1");
    expect(user.role).toBe("ADMIN");
    await expect(acceptInvite(newToken, "a-strong-passphrase-1")).rejects.toThrow(/invalid or has expired/);
    const list = await recentInvites();
    expect(list).toHaveLength(1);
    expect(inviteState(list[0])).toBe("ACTIVATED");
    await expect(resendInvite(tabitha, second.inviteId)).rejects.toThrow(/already used/);
  });

  it("revoked links stop working", async () => {
    const tabitha = await makeUser("ADMIN");
    const out = await inviteStaff(tabitha, { email: "rev@example.com", name: "Rev", role: "STAFF" });
    const token = tokenFrom(sent[0]);
    await revokeInvite(tabitha, out.inviteId);
    expect(await findOpenInvite(token)).toBeNull();
    await expect(acceptInvite(token, "a-strong-passphrase-1")).rejects.toThrow(/invalid or has expired/);
    await expect(revokeInvite(tabitha, out.inviteId)).rejects.toThrow(/isn't open/);
    expect(inviteState(await prisma.invite.findUniqueOrThrow({ where: { id: out.inviteId } }))).toBe("REVOKED");
  });

  it("expired links stop working and can be re-sent as a new 7-day link", async () => {
    const tabitha = await makeUser("ADMIN");
    const out = await inviteStaff(tabitha, { email: "exp@example.com", name: "Exp", role: "STAFF" });
    const token = tokenFrom(sent[0]);
    await prisma.invite.update({ where: { id: out.inviteId }, data: { expiresAt: new Date(Date.now() - 1000), emailAttemptAt: new Date(Date.now() - 8 * 86400e3) } });
    expect(await findOpenInvite(token)).toBeNull();
    expect(inviteState(await prisma.invite.findUniqueOrThrow({ where: { id: out.inviteId } }))).toBe("EXPIRED");
    const again = await resendInvite(tabitha, out.inviteId);
    expect(again.status).toBe("sent");
    expect(await findOpenInvite(tokenFrom(sent[1]))).not.toBeNull();
  });

  it("a fresh invitation supersedes an expired one for the same address", async () => {
    const tabitha = await makeUser("ADMIN");
    const out = await inviteStaff(tabitha, { email: "old@example.com", name: "Old", role: "STAFF" });
    await prisma.invite.update({ where: { id: out.inviteId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const fresh = await inviteStaff(tabitha, { email: "old@example.com", name: "Old", role: "STAFF" });
    const old = await prisma.invite.findUniqueOrThrow({ where: { id: out.inviteId } });
    expect(old.replacedById).toBe(fresh.inviteId);
    expect((await recentInvites()).map((i) => i.id)).toEqual([fresh.inviteId]);
  });

  it("when sending fails it records the failure and returns a private link to the Admin only", async () => {
    const tabitha = await makeUser("ADMIN");
    reply = () => new Response(JSON.stringify({ message: "The mail.example.com domain is not verified." }), { status: 403 });
    const out = await inviteStaff(tabitha, { email: "fail@example.com", name: "Fail", role: "STAFF" });
    expect(out.status).toBe("not_sent");
    expect(out.message).toMatch(/domain is not verified/);
    expect(out.privateLink).toMatch(/^https:\/\/crm\.example\.com\/staff\/invite\//);
    const invite = await prisma.invite.findUniqueOrThrow({ where: { id: out.inviteId } });
    expect(inviteState(invite)).toBe("FAILED");
    expect(invite.emailError).toMatch(/HTTP 403/);
    // The fallback link works.
    expect(await findOpenInvite(tokenOf(out.privateLink!))).not.toBeNull();

    // A failed send can be retried immediately once fixed.
    reply = () => new Response(JSON.stringify({ id: "re_ok" }), { status: 200 });
    const retry = await resendInvite(tabitha, out.inviteId);
    expect(retry.status).toBe("sent");
    expect(await findOpenInvite(tokenOf(out.privateLink!))).toBeNull();
  });

  it("network errors count as a failure, not a send", async () => {
    const tabitha = await makeUser("ADMIN");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const out = await inviteStaff(tabitha, { email: "net@example.com", name: "Net", role: "STAFF" });
    expect(out.status).toBe("not_sent");
    expect(out.privateLink).toBeDefined();
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: out.inviteId } })).emailStatus).toBe("FAILED");
  });

  it("without email configured it saves the invitation and offers the private link", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const tabitha = await makeUser("ADMIN");
    const out = await inviteStaff(tabitha, { email: "nokey@example.com", name: "NoKey", role: "STAFF" });
    expect(sent).toHaveLength(0);
    expect(out.status).toBe("not_sent");
    expect(out.message).toMatch(/isn't set up/);
    const invite = await prisma.invite.findUniqueOrThrow({ where: { id: out.inviteId } });
    expect(inviteState(invite)).toBe("CREATED");
    expect(await findOpenInvite(tokenOf(out.privateLink!))).not.toBeNull();
  });

  it("a new private link replaces any emailed link", async () => {
    const tabitha = await makeUser("ADMIN");
    const out = await inviteStaff(tabitha, { email: "copy@example.com", name: "Copy", role: "STAFF" });
    const emailed = tokenFrom(sent[0]);
    const copy = await createPrivateInviteLink(tabitha, out.inviteId);
    expect(sent).toHaveLength(1); // nothing new emailed
    expect(await findOpenInvite(emailed)).toBeNull();
    expect(await findOpenInvite(tokenOf(copy.privateLink!))).not.toBeNull();
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: copy.inviteId } })).linkCopiedAt).not.toBeNull();
  });

  it("delivery is confirmed only by a signed provider event, and a bounce shows as failed", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec_" + Buffer.from("test-webhook-secret-123456").toString("base64"));
    const secret = process.env.RESEND_WEBHOOK_SECRET!;
    const tabitha = await makeUser("ADMIN");
    const a = await inviteStaff(tabitha, { email: "ok@example.com", name: "Ok", role: "STAFF" });
    const b = await inviteStaff(tabitha, { email: "bounce@example.com", name: "Bounce", role: "STAFF" });
    const idA = (await prisma.invite.findUniqueOrThrow({ where: { id: a.inviteId } })).emailProviderId!;
    const idB = (await prisma.invite.findUniqueOrThrow({ where: { id: b.inviteId } })).emailProviderId!;

    const post = (payload: object, sign = true) => {
      const body = JSON.stringify(payload);
      const ts = String(Math.floor(Date.now() / 1000));
      return resendWebhook(
        new Request("https://crm.example.com/api/webhooks/resend", {
          method: "POST",
          body,
          headers: { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": sign ? resendSignatureFor(secret, "msg_1", ts, body) : "v1,bm9wZQ==" },
        }),
      );
    };
    expect((await post({ type: "email.delivered", data: { email_id: idA } }, false)).status).toBe(403);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: a.inviteId } })).emailStatus).toBe("ACCEPTED");

    expect((await post({ type: "email.delivered", data: { email_id: idA } })).status).toBe(204);
    expect(inviteState(await prisma.invite.findUniqueOrThrow({ where: { id: a.inviteId } }))).toBe("DELIVERED");

    await post({ type: "email.bounced", data: { email_id: idB, bounce: { message: "Mailbox does not exist" } } });
    const bounced = await prisma.invite.findUniqueOrThrow({ where: { id: b.inviteId } });
    expect(inviteState(bounced)).toBe("FAILED");
    expect(bounced.emailError).toMatch(/bounced.*Mailbox does not exist/);

    // A late complaint never downgrades a confirmed delivery.
    await applyInviteEmailEvent("email.complained", idA);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: a.inviteId } })).emailStatus).toBe("DELIVERED");
    // Unknown email ids are ignored.
    expect(await applyInviteEmailEvent("email.delivered", "re_unknown")).toBe(false);
  });

  it("rejects stale or forged webhook signatures", () => {
    const secret = "whsec_" + Buffer.from("k".repeat(24)).toString("base64");
    const body = '{"type":"email.delivered"}';
    const ts = "1700000000";
    const signature = resendSignatureFor(secret, "id1", ts, body);
    expect(verifyResendSignature(secret, { id: "id1", timestamp: ts, signature }, body, 1700000000)).toBe(true);
    expect(verifyResendSignature(secret, { id: "id1", timestamp: ts, signature }, body, 1700000000 + 600)).toBe(false);
    expect(verifyResendSignature(secret, { id: "id1", timestamp: ts, signature }, body + " ", 1700000000)).toBe(false);
    expect(verifyResendSignature(secret, { id: "id2", timestamp: ts, signature }, body, 1700000000)).toBe(false);
  });

  it("the email names the firm and never carries client data", () => {
    const mail = staffInvitationEmail({ name: "Daria <b>", role: "STAFF", invitedBy: "Tabitha", link: "https://crm.example.com/staff/invite/abc", expiresAt: new Date("2026-11-05T12:00:00Z") });
    expect(mail.html).toContain("Daria &lt;b&gt;");
    expect(mail.html).toContain("Create Your Staff Account");
    expect(mail.text).toContain("November 5, 2026");
    expect(mail.text).toContain("T. Turner & Associates, LLC");
  });
});
