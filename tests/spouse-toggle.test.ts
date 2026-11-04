import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { makeUser, prisma, resetDb } from "./db";
import { createClient, currentTaxYear, spouseSectionDefaults, updateClient } from "@/lib/services/clients";
import { SpouseSection, spouseSectionView } from "@/components/spouse-section";
import { ClientForm } from "@/components/client-form";

beforeEach(resetDb);

const empty = { spouseFirstName: "", spouseMiddleName: "", spouseLastName: "", spouseEmail: "", spousePhone: "" };
const section = (p: Partial<Parameters<typeof SpouseSection>[0]> = {}) =>
  renderToStaticMarkup(createElement(SpouseSection, { year: 2025, initialOpen: false, initialType: "INDIVIDUAL", values: empty, savedEarlier: false, ...p }));
const fieldsHidden = (html: string) => /<fieldset id="spouse-fields" disabled="" hidden=""/.test(html);
const base = { firstName: "Riley", lastName: "Fictional", clientType: "INDIVIDUAL" as const, status: "ACTIVE" as const };

describe("Add spouse / Joint tax return toggle", () => {
  it("is collapsed by default on Create: box offered, spouse fields hidden and not sent", () => {
    const html = section();
    expect(html).toContain("Add spouse / Joint tax return");
    expect(html).toContain('data-open="false"');
    expect(html).toContain('data-offered="true"');
    expect(fieldsHidden(html)).toBe(true);
    expect(spouseSectionView({ clientType: "INDIVIDUAL", businessReturn: false, checked: false })).toEqual({ offered: true, expanded: false });
  });

  it("ticking the box shows the spouse fields", () => {
    expect(spouseSectionView({ clientType: "INDIVIDUAL", businessReturn: false, checked: true })).toEqual({ offered: true, expanded: true });
    const html = section({ initialOpen: true });
    expect(html).toContain('data-open="true"');
    expect(fieldsHidden(html)).toBe(false);
    for (const name of ["spouseFirstName", "spouseMiddleName", "spouseLastName", "spouseEmail", "spousePhone"]) expect(html).toContain(`name="${name}"`);
  });

  it("collapsed, the mailing address directly follows the primary contact info", () => {
    const html = renderToStaticMarkup(createElement(ClientForm, { action: async () => null, groups: [], staff: [], cancelHref: "/clients" }));
    const phone = html.indexOf('name="phone"');
    const address = html.indexOf('name="addressLine1"');
    const spouse = html.indexOf('data-testid="spouse-section"');
    expect(phone).toBeGreaterThan(0);
    expect(address).toBeGreaterThan(phone);
    expect(spouse).toBeGreaterThan(address);
    expect(html.slice(phone, address)).not.toContain("spouse");
  });

  it("a joint return for the current tax year opens it (recorded answer, MFJ case or MFJ summary)", async () => {
    const staff = await makeUser("STAFF");
    const year = currentTaxYear();
    const flagged = await createClient(staff, { ...base, spouseNeeded: true, spouseYear: year, spouseFirstName: "Casey", spouseLastName: "Fictional" });
    expect((await spouseSectionDefaults(flagged.id, year)).open).toBe(true);

    const mfj = await createClient(staff, { ...base, firstName: "Jordan" });
    await prisma.taxPrepCase.create({ data: { clientId: mfj.id, taxYear: year, returnType: "1040_MFJ" } });
    expect((await spouseSectionDefaults(mfj.id, year)).open).toBe(true);

    const summary = await createClient(staff, { ...base, firstName: "Sky" });
    await prisma.taxReturnSummary.create({ data: { clientId: summary.id, taxYear: year, filingStatus: "MFJ", taxpayerName: "Sky Fictional", figuresHash: "x", preparedById: staff.id } });
    expect((await spouseSectionDefaults(summary.id, year)).open).toBe(true);

    // Never assumed: a plain individual, and an MFS return, start collapsed.
    const plain = await createClient(staff, { ...base, firstName: "Avery" });
    expect(await spouseSectionDefaults(plain.id, year)).toEqual({ businessReturn: false, open: false });
    await prisma.taxPrepCase.create({ data: { clientId: plain.id, taxYear: year, returnType: "1040_MFS" } });
    expect((await spouseSectionDefaults(plain.id, year)).open).toBe(false);
  });

  it("a prior-year joint return alone keeps it collapsed for the current year", async () => {
    const staff = await makeUser("STAFF");
    const year = currentTaxYear();
    const c = await createClient(staff, { ...base, spouseNeeded: true, spouseYear: year - 1, spouseFirstName: "Pat", spouseLastName: "Fictional" });
    await prisma.taxPrepCase.create({ data: { clientId: c.id, taxYear: year - 1, returnType: "1040_MFJ" } });
    await prisma.taxReturnSummary.create({ data: { clientId: c.id, taxYear: year - 1, filingStatus: "MFJ", taxpayerName: "Riley Fictional", figuresHash: "x", preparedById: staff.id } });
    expect((await spouseSectionDefaults(c.id, year)).open).toBe(false);
    expect((await spouseSectionDefaults(c.id, year - 1)).open).toBe(true);
    const html = section({ initialOpen: false, savedEarlier: true });
    expect(fieldsHidden(html)).toBe(true);
    expect(html).toContain("on file from an earlier year");
  });

  it("business-only clients never get the box or the section", async () => {
    for (const clientType of ["BUSINESS", "NONPROFIT"]) {
      expect(spouseSectionView({ clientType, businessReturn: false, checked: true })).toEqual({ offered: false, expanded: false });
      const html = section({ initialType: clientType, initialOpen: true });
      expect(html).toMatch(/<div hidden="" data-testid="spouse-section" data-open="false" data-offered="false"/);
    }
    expect(spouseSectionView({ clientType: "INDIVIDUAL", businessReturn: true, checked: true })).toEqual({ offered: false, expanded: false });
    expect(section({ businessReturn: true, initialOpen: true })).toContain('data-offered="false"');

    const staff = await makeUser("STAFF");
    const year = currentTaxYear();
    const biz = await createClient(staff, { businessName: "Fictional Pine Works LLC", clientType: "BUSINESS", status: "ACTIVE" });
    await prisma.jointFilingYear.create({ data: { clientId: biz.id, taxYear: year, needed: true, source: "STAFF" } });
    expect(await spouseSectionDefaults(biz.id, year)).toEqual({ businessReturn: false, open: false });
    for (const returnType of ["1065", "1120S", "1120", "990"]) {
      const ind = await createClient(staff, { ...base, firstName: `R${returnType}` });
      await prisma.taxPrepCase.create({ data: { clientId: ind.id, taxYear: year, returnType } });
      expect(await spouseSectionDefaults(ind.id, year)).toEqual({ businessReturn: true, open: false });
    }
  });

  it("hiding the section and saving keeps the spouse on file (Edit), for an individual or a business", async () => {
    const staff = await makeUser("STAFF");
    const year = currentTaxYear();
    const spouse = { spouseFirstName: "Morgan", spouseMiddleName: "Q", spouseLastName: "Fictional", spouseEmail: "morgan@example.com", spousePhone: "2055550142" };
    const c = await createClient(staff, { ...base, spouseNeeded: true, spouseYear: year, ...spouse });
    // Unticked: the browser sends no spouse fields (disabled), just the marker and year.
    const saved = await updateClient(staff, c.id, { ...base, city: "Tuscaloosa", spouseNeeded: false, spouseYear: year });
    expect(saved.city).toBe("Tuscaloosa");
    expect(saved).toMatchObject({ spouseFirstName: "Morgan", spouseMiddleName: "Q", spouseLastName: "Fictional", spouseEmail: "morgan@example.com", spousePhone: "(205) 555-0142" });
    // The year's answer is recorded as "no" (so it starts collapsed), the spouse itself is untouched.
    expect((await spouseSectionDefaults(c.id, year)).open).toBe(false);

    // Hidden because Client type became Business (no year sent): still kept, no new answer recorded.
    const asBiz = await updateClient(staff, c.id, { ...base, clientType: "BUSINESS", businessName: "Fictional Pine Works LLC", spouseNeeded: false });
    expect(asBiz.spouseFirstName).toBe("Morgan");
    expect(asBiz.spousePhone).toBe("(205) 555-0142");
    expect(await prisma.auditLog.count({ where: { clientId: c.id, action: "client.joint_filing_set" } })).toBe(2);

    // Ticking again shows and saves it as edited.
    const back = await updateClient(staff, c.id, { ...base, spouseNeeded: true, spouseYear: year, ...spouse, spouseFirstName: "Morgana" });
    expect(back.spouseFirstName).toBe("Morgana");
    expect((await spouseSectionDefaults(c.id, year)).open).toBe(true);
  });

  it("Create with the box unticked saves no spouse (never assumes married)", async () => {
    const staff = await makeUser("STAFF");
    const c = await createClient(staff, { ...base, spouseNeeded: false, spouseYear: currentTaxYear() });
    expect(c.spouseFirstName).toBeNull();
    expect(await prisma.jointFilingYear.count({ where: { clientId: c.id } })).toBe(0);
  });
});
