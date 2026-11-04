// Physical vs mailing address on the client record. Fictional people and addresses only.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { grantPerms, makeUser, prisma, resetDb } from "./db";
import { createClient, updateClient, ValidationError, type ClientInput } from "@/lib/services/clients";
import { billingContactOf } from "@/lib/services/owner-billing";
import { invoiceClientChoices } from "@/lib/services/firm-invoices";
import { addressComplete, billingAddressOf, formatAddressBlock, mailingAddressOf, streetAddressOf } from "@/lib/client-address";

beforeEach(resetDb);

const physical = { addressLine1: "21 Example Ave", addressLine2: "Apt 2", city: "Hoover", state: "AL", postalCode: "35244" };
const mailing = { mailingAddressLine1: "PO Box 1200", mailingAddressLine2: "", mailingCity: "Bessemer", mailingState: "al", mailingPostalCode: "35021-0012" };
const base: ClientInput = { firstName: "Quinn", lastName: "Fictional", clientType: "INDIVIDUAL", status: "ACTIVE" };
// What the Create/Edit client screens send.
const form = (extra: Partial<ClientInput>): ClientInput => ({ ...base, ...physical, mailingSection: true, mailingSameAsAddress: true, ...extra });

describe("billing and mail use the mailing address", () => {
  it("bills to the separate mailing address; otherwise the physical address", async () => {
    const tab = await makeUser("ADMIN");
    const sep = await createClient(tab, form({ mailingSameAsAddress: false, ...mailing }));
    const same = await createClient(tab, form({ firstName: "Rowan", lastName: "Sample" }));
    // An older record: mailing columns never set.
    const old = await prisma.client.create({ data: { firstName: "Sage", lastName: "Older", displayName: "Sage Older", ...physical, clientType: "INDIVIDUAL" } });
    // Marked separate but incomplete: mail still goes to the physical address.
    const partial = await prisma.client.create({ data: { firstName: "Tess", lastName: "Partial", displayName: "Tess Partial", ...physical, mailingSameAsAddress: false, mailingAddressLine1: "PO Box 9", clientType: "INDIVIDUAL" } });

    expect((await billingContactOf(sep.id)).billingAddress).toBe("PO Box 1200\nBessemer, AL 35021-0012");
    expect((await billingContactOf(same.id)).billingAddress).toBe("21 Example Ave\nApt 2\nHoover, AL 35244");
    expect((await billingContactOf(old.id)).billingAddress).toBe("21 Example Ave\nApt 2\nHoover, AL 35244");
    expect((await billingContactOf(partial.id)).billingAddress).toBe("21 Example Ave\nApt 2\nHoover, AL 35244");

    // The Create Invoice client picker prefills the same bill-to.
    const daria = await makeUser("STAFF");
    await grantPerms(daria.id, ["billing.view"]);
    const choices = await invoiceClientChoices(daria);
    expect(choices.find((c) => c.id === sep.id)!.address).toBe("PO Box 1200\nBessemer, AL 35021-0012");
    expect(choices.find((c) => c.id === same.id)!.address).toBe("21 Example Ave\nApt 2\nHoover, AL 35244");

    // The physical address is still there for residence / profile.
    const s = await prisma.client.findUniqueOrThrow({ where: { id: sep.id } });
    expect(formatAddressBlock(streetAddressOf(s))).toBe("21 Example Ave\nApt 2\nHoover, AL 35244");
    expect(mailingAddressOf(s).line1).toBe("PO Box 1200");
    expect(billingAddressOf(s)).toEqual(mailingAddressOf(s));
  });
});

describe("Create / Edit client: physical and mailing address", () => {
  it("saves both blocks, and ticking 'same as physical' clears the mailing columns", async () => {
    const tab = await makeUser("ADMIN");
    const c = await createClient(tab, form({ mailingSameAsAddress: false, ...mailing }));
    expect([c.addressLine1, c.addressLine2, c.city, c.state, c.postalCode]).toEqual(["21 Example Ave", "Apt 2", "Hoover", "AL", "35244"]);
    expect([c.mailingSameAsAddress, c.mailingAddressLine1, c.mailingAddressLine2, c.mailingCity, c.mailingState, c.mailingPostalCode]).toEqual([false, "PO Box 1200", null, "Bessemer", "AL", "35021-0012"]);

    // Edit: change the mailing ZIP.
    const e = await updateClient(tab, c.id, form({ mailingSameAsAddress: false, ...mailing, mailingPostalCode: "35020" }));
    expect(e.mailingPostalCode).toBe("35020");

    // Edit: tick "same as physical".
    const cleared = await updateClient(tab, c.id, form({ mailingSameAsAddress: true, ...mailing }));
    expect([cleared.mailingSameAsAddress, cleared.mailingAddressLine1, cleared.mailingCity, cleared.mailingState, cleared.mailingPostalCode]).toEqual([true, null, null, null, null]);
    expect(cleared.addressLine1).toBe("21 Example Ave"); // physical untouched
  });

  it("requires a complete mailing address when the box is unticked", async () => {
    const tab = await makeUser("ADMIN");
    await expect(createClient(tab, form({ mailingSameAsAddress: false, mailingAddressLine1: "PO Box 1" }))).rejects.toThrow(/complete mailing address/);
    await expect(createClient(tab, form({ mailingSameAsAddress: false, ...mailing, mailingState: "Alabama" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(createClient(tab, form({ mailingSameAsAddress: false, ...mailing, mailingPostalCode: "3502" }))).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.client.count()).toBe(0);
  });

  it("callers without the address blocks (imports, other forms) leave mailing and flags alone", async () => {
    const tab = await makeUser("ADMIN");
    const c = await prisma.client.create({ data: { firstName: "Uma", lastName: "Sample", displayName: "Uma Sample", ...physical, mailingSameAsAddress: false, mailingAddressLine1: "PO Box 5", mailingCity: "Hoover", mailingState: "AL", mailingPostalCode: "35244", clientType: "INDIVIDUAL", tags: ["Address Needed"] } });
    const u = await updateClient(tab, c.id, { ...base, firstName: "Uma", lastName: "Sample", ...physical, tags: "Address Needed" });
    expect([u.mailingSameAsAddress, u.mailingAddressLine1]).toEqual([false, "PO Box 5"]);
    expect(u.tags).toEqual(["Address Needed"]);
  });
});

describe("Address Needed clears on a valid save", () => {
  it("clears with an audit entry when complete; stays (or is set) while incomplete", async () => {
    const tab = await makeUser("ADMIN");
    const c = await prisma.client.create({ data: { firstName: "Vale", lastName: "Example", displayName: "Vale Example", clientType: "INDIVIDUAL", tags: ["Address Needed", "2025 return"] } });

    // Still incomplete: no ZIP, then a bad state. The tag stays even if removed from the Tags box.
    let u = await updateClient(tab, c.id, form({ firstName: "Vale", lastName: "Example", postalCode: "", tags: "2025 return" }));
    expect(u.tags).toEqual(["2025 return", "Address Needed"]);
    u = await updateClient(tab, c.id, form({ firstName: "Vale", lastName: "Example", state: "Alabama", tags: "Address Needed, 2025 return" }));
    expect(u.tags).toContain("Address Needed");
    // Separate mailing address can't be saved incomplete at all.
    await expect(updateClient(tab, c.id, form({ firstName: "Vale", lastName: "Example", mailingSameAsAddress: false, mailingAddressLine1: "PO Box 3", tags: "Address Needed, 2025 return" }))).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.auditLog.count({ where: { action: "client.address_needed_cleared" } })).toBe(0);

    // Complete and valid (ZIP+4, separate mailing): cleared, audited.
    u = await updateClient(tab, c.id, form({ firstName: "Vale", lastName: "Example", postalCode: "35244-1234", mailingSameAsAddress: false, ...mailing, tags: "Address Needed, 2025 return" }));
    expect(u.tags).toEqual(["2025 return"]);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "client.address_needed_cleared", clientId: c.id } });
    expect(log.actorId).toBe(tab.id);

    // A new client saved with no address is flagged.
    const n = await createClient(tab, form({ firstName: "Wren", lastName: "New", addressLine1: "", city: "" }));
    expect(n.tags).toEqual(["Address Needed"]);
    expect(await prisma.auditLog.count({ where: { action: "client.address_needed_set", clientId: n.id } })).toBe(1);
    expect(addressComplete(n)).toBe(false);
  });
});

describe("existing clients after the migration", () => {
  it("is additive only, and existing records keep their address and current behavior", async () => {
    const sql = readFileSync("netlify/database/migrations/20261106800000_import_missing_info/migration.sql", "utf8");
    expect(sql).not.toMatch(/\b(DROP|UPDATE|DELETE|RENAME|NOT NULL)\b/i);
    expect(sql.match(/ADD COLUMN/g)?.length).toBe(10);

    // A row written without the new columns (as every pre-migration row is).
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Client" (id, "firstName", "lastName", "displayName", "addressLine1", city, state, "postalCode", "clientType", status, services, tags, "updatedAt") VALUES ('legacy1', 'Xen', 'Legacy', 'Xen Legacy', '4 Original St', 'Birmingham', 'AL', '35203', 'INDIVIDUAL', 'ACTIVE', '{}', '{}', now())`,
    );
    const c = await prisma.client.findUniqueOrThrow({ where: { id: "legacy1" } });
    expect([c.addressLine1, c.city, c.state, c.postalCode]).toEqual(["4 Original St", "Birmingham", "AL", "35203"]);
    expect([c.mailingSameAsAddress, c.mailingAddressLine1, c.mailingCity]).toEqual([null, null, null]);
    expect((await billingContactOf(c.id)).billingAddress).toBe("4 Original St\nBirmingham, AL 35203"); // as before
    expect(c.tags).toEqual([]);
  });
});
