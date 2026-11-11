import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { staffSendMessage } from "@/lib/services/messaging";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { requireClientAccess } from "@/lib/portal/access";
import { loadPortalHome } from "@/lib/portal/views";
import { booksStatus } from "@/lib/services/portal-business";

// Fictional clients only. A staff-only thread (internal notes, email or text) must never show its
// subject in the client portal; neither may a thread private to another login.
beforeEach(resetDb);

async function setup() {
  const staff = await makeUser("ADMIN", "Tabitha");
  const client = await createClient(staff, { businessName: "Harbor Example Studio (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  const { token } = await invitePortalUser(staff, client.id, { email: "owner@harbor.example", name: "Quinn Example", role: "OWNER" });
  const login = await acceptPortalInvite(token!, "Client-Pass-12345");
  return { staff, client, login };
}

describe("Conversation subjects in the client portal", () => {
  it("the portal Home lists only portal threads, never a staff-only note's subject", async () => {
    const s = await setup();
    await staffSendMessage(s.staff, { clientId: s.client.id, subject: "INTERNAL: collections concern", body: "Staff-only note.", channel: "INTERNAL_NOTE" });
    await staffSendMessage(s.staff, { clientId: s.client.id, subject: "Your 2025 documents", body: "Hello from the office.", channel: "PORTAL" });
    const perms = await requireClientAccess(s.login.id, s.client.id);
    const home = await loadPortalHome(s.client.id, perms, s.login.id);
    const subjects = home.threads.map((t: { subject: string }) => t.subject);
    expect(subjects).toEqual(["Your 2025 documents"]);
    expect(JSON.stringify(home)).not.toContain("collections concern");
  });

  it("open bookkeeping questions on the business dashboard skip staff-only threads and threads private to one login", async () => {
    const s = await setup();
    // A staff-only thread someone marked as a question (the original exposure path) ...
    await staffSendMessage(s.staff, { clientId: s.client.id, subject: "INTERNAL: owner draws look off", body: "Staff-only note.", channel: "INTERNAL_NOTE" });
    const internal = await prisma.conversation.findFirstOrThrow({ where: { clientId: s.client.id, subject: { startsWith: "INTERNAL" } } });
    await prisma.conversation.update({ where: { id: internal.id }, data: { questionStatus: "OPEN" } });
    // ... a portal thread private to one login ...
    const privateMsg = await staffSendMessage(s.staff, { clientId: s.client.id, subject: "Private question for Quinn", body: "Only Quinn.", channel: "PORTAL" });
    await prisma.conversation.update({ where: { id: privateMsg.conversationId }, data: { questionStatus: "OPEN", privateToPortalUserId: s.login.id } });
    // ... and an ordinary question sent through the portal.
    const shared = await staffSendMessage(s.staff, { clientId: s.client.id, subject: "What was the June 3 deposit?", body: "Please tell us.", channel: "PORTAL" });
    await prisma.conversation.update({ where: { id: shared.conversationId }, data: { questionStatus: "OPEN" } });

    const status = await booksStatus(s.client.id);
    const text = JSON.stringify(status);
    expect(text).toContain("What was the June 3 deposit?");
    expect(text).not.toContain("owner draws look off");
    expect(text).not.toContain("Private question for Quinn");
  });
});
