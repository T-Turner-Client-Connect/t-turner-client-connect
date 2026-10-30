import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient, saveContact } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { greetingName, loadGreetingName } from "@/lib/portal/greeting";

beforeEach(async () => {
  await resetDb();
});

describe("portal greeting", () => {
  it("uses preferred names, then the business name; never 'there'", async () => {
    const base = { preferredName: null, firstName: null, businessName: null, displayName: "" };
    expect(greetingName({ ...base, clientType: "INDIVIDUAL", firstName: "Elizabeth", preferredName: "Liz" })).toBe("Liz");
    expect(greetingName({ ...base, clientType: "INDIVIDUAL", firstName: "Elizabeth" })).toBe("Elizabeth");
    expect(greetingName({ ...base, clientType: "INDIVIDUAL" })).toBeNull();
    expect(greetingName({ ...base, clientType: "BUSINESS", businessName: "Fictional & Associates, LLC" }, { preferredName: "Nate" })).toBe("Nate");
    expect(greetingName({ ...base, clientType: "BUSINESS", businessName: "Fictional & Associates, LLC" }, { preferredName: null })).toBe("Fictional & Associates, LLC");
  });

  it("staff preview greets with the selected client's details; a login greets with its own contact's preferred name", async () => {
    const staff = await makeUser("ADMIN", "Tabitha Staffmember");
    const biz = await createClient(staff, { businessName: "Fictional & Associates, LLC", clientType: "BUSINESS", status: "ACTIVE" });
    // No contact name yet: preview falls back to the business name, not the staff member.
    expect(await loadGreetingName(biz.id, null)).toBe("Fictional & Associates, LLC");
    const contact = await saveContact(staff, biz.id, null, { name: "Nathaniel Example", preferredName: "Nate", email: "nate@fictional.example" });
    const { token } = await invitePortalUser(staff, biz.id, { email: "nate@fictional.example", name: "Nathaniel Example", role: "OWNER" });
    const user = await acceptPortalInvite(token!, "Portal-Pass-12345");
    await prisma.portalUser.update({ where: { id: user.id }, data: { contactId: contact.id } });
    expect(await loadGreetingName(biz.id, user.id)).toBe("Nate");
    expect(await loadGreetingName(biz.id, null)).toBe("Nate"); // preview: the owner login's contact
    const person = await createClient(staff, { firstName: "Elizabeth", lastName: "Example", preferredName: "Liz", clientType: "INDIVIDUAL", status: "ACTIVE" });
    expect(await loadGreetingName(person.id, null)).toBe("Liz");
  });
});
