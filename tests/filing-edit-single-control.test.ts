import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { attachFilingDocument, createFiling, setFilingStatusByStaff } from "@/lib/services/tax";
import { staffUploadDocument } from "@/lib/services/documents";
import { fileReturn } from "@/lib/services/tax-returns";
import { editFilingDetails, moveFilingDocument, removeFiling } from "@/lib/services/accepted-returns";
import * as taxActions from "@/app/actions/tax";
import { TaxesTab } from "@/components/client-tabs/taxes";
import { setReturnGate } from "@/lib/services/return-gate";

// Placeholder PDFs here carry no return text; the return upload gate itself is tested in return-gate.test.ts.
beforeEach(() => setReturnGate(async () => "VERIFIED"));
afterEach(() => setReturnGate(null));

/**
 * #122 + #124 reconciled: one correction control per filing card ("Edit filing
 * details", in More options), Tabitha only, and a form-number change made
 * there is #124's audited correction. Fictional client and staff only.
 */
const pdf = (tag: string) => new TextEncoder().encode(`%PDF-1.4\n% fictional ${tag}\n`);

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
  const otherAdmin = await makeUser("ADMIN", "Other Admin");
  const daria = await makeUser("STAFF", "Daria");
  const client = await createClient(tabitha, { firstName: "Marigold", lastName: "Fictional", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const owner = { form8879Confirmed: true, overrideReason: "Fictional test filing" };
  const fed = await createFiling(tabitha, { clientId: client.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
  const al = await createFiling(tabitha, { clientId: client.id, taxYear: 2025, returnType: "1040", jurisdiction: "AL", filingType: "ORIGINAL" });
  for (const f of [fed, al]) await setFilingStatusByStaff(tabitha, f.id, { status: "ACCEPTED", verificationNote: "Checked ack in TaxAct (fictional)", submission: owner });
  const doc = await fileReturn(tabitha, { clientId: client.id, taxYear: 2025, returnType: "1040", jurisdiction: "AL", filingType: "ORIGINAL", bytes: pdf("al"), originalName: "al.pdf" });
  return { tabitha, otherAdmin, daria, client, fed, al, doc };
}

type El = { type: unknown; props: Record<string, unknown> };
/** Every element in the tree TaxesTab returns (without rendering child components), and every text string. */
function walk(node: unknown, els: El[] = [], text: string[] = []) {
  if (Array.isArray(node)) for (const n of node) walk(n, els, text);
  else if (typeof node === "string" || typeof node === "number") text.push(String(node));
  else if (isValidElement(node)) {
    const el = node as unknown as El;
    els.push(el);
    for (const v of Object.values(el.props)) if (Array.isArray(v) || isValidElement(v) || typeof v === "string") walk(v, els, text);
  }
  return { els, text };
}
const actionName = (e: El) => (typeof e.props.action === "function" ? (e.props.action as { name: string }).name : "");
const hasInput = (e: El, name: string) => walk(e.props.children as ReactNode).els.some((c) => c.type === "input" && c.props.name === name);
const tab = async (clientId: string, user: Actor) => walk(await TaxesTab({ clientId, user }));

describe("One correction control per filing card", () => {
  it("Tabitha: each card's only form-number field is in Edit filing details; #124's standalone control isn't rendered", async () => {
    const { tabitha, client } = await setup();
    const { els, text } = await tab(client.id, tabitha);
    const forms = els.filter((e) => actionName(e));
    // The forms on the cards that change a filing's form number (the "Add a filing" form creates one instead).
    const formNumberForms = forms.filter((e) => hasInput(e, "returnType") && actionName(e) !== "bound createFilingAction");
    expect(formNumberForms.map(actionName)).toEqual(["bound editFilingDetailsAction", "bound editFilingDetailsAction"]); // Federal + AL
    expect(forms.some((e) => /correctFilingForm/.test(actionName(e)))).toBe(false);
    const all = text.join(" ");
    expect(all).not.toMatch(/Correct form number/);
    expect(all.match(/Edit filing details/g)).toHaveLength(2);
    expect(all).toMatch(/Tabitha only/);
    // Remove filing and Move are there for her too.
    expect(forms.filter((e) => actionName(e) === "bound removeFilingAction")).toHaveLength(2);
    expect(forms.some((e) => actionName(e) === "bound moveFilingDocAction")).toBe(true);
    // The standalone server action from #124 is gone too, so there is no second way in.
    expect(taxActions).not.toHaveProperty("correctFilingFormAction");
  });

  it("other Admins and staff see no Edit filing details, Remove filing or Move", async () => {
    const { otherAdmin, daria, client } = await setup();
    for (const user of [otherAdmin, daria]) {
      const { els, text } = await tab(client.id, user);
      const names = els.map(actionName);
      for (const n of ["bound editFilingDetailsAction", "bound removeFilingAction", "bound moveFilingDocAction"]) expect(names).not.toContain(n);
      expect(text.join(" ")).not.toMatch(/Edit filing details|Correct form number/);
    }
  });

  it("the server refuses them for other Admins and staff", async () => {
    const { otherAdmin, daria, fed, al, doc } = await setup();
    const input = { taxYear: 2025, returnType: "40", jurisdiction: "AL", filingType: "ORIGINAL" as const };
    for (const user of [otherAdmin, daria]) {
      await expect(editFilingDetails(user, al.id, input, "Entered as 1040 by mistake")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(removeFiling(user, al.id, "Created by mistake")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(moveFilingDocument(user, doc.id, fed.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await prisma.filingRecord.findUniqueOrThrow({ where: { id: al.id } })).returnType).toBe("1040");
  });
});

describe("A form-number change in Edit filing details is #124's audited correction", () => {
  const al40 = { taxYear: 2025, returnType: "40", jurisdiction: "AL", filingType: "ORIGINAL" as const };

  it("same FORM event with the reason, same filing.form_corrected entry listing renamed documents, whole-word renaming, labelled “Form number”", async () => {
    const { tabitha, client, al, doc } = await setup();
    const notice = await staffUploadDocument(tabitha, { clientId: client.id, category: "TAXES", title: "Notice 10401 follow-up", year: 2025, visibility: "STAFF_ONLY", bytes: pdf("n"), originalName: "n.pdf" });
    await attachFilingDocument(tabitha, al.id, notice.id, "CORRESPONDENCE");
    const r = await editFilingDetails(tabitha, al.id, al40, "Entered as 1040 by mistake");
    expect(r.formCorrection).toEqual({ from: "1040", to: "40", renamed: 1 });
    expect(r.filingStatus).toBe("ACCEPTED");
    const ev = await prisma.filingStatusEvent.findFirstOrThrow({ where: { filingId: al.id, field: "FORM" } });
    expect([ev.fromValue, ev.toValue, ev.verificationNote, ev.actorId]).toEqual(["1040", "40", "Entered as 1040 by mistake", tabitha.id]);
    expect(await prisma.filingStatusEvent.count({ where: { filingId: al.id, field: "DETAILS" } })).toBe(0);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "filing.form_corrected", entityId: al.id } });
    expect(log.details).toEqual({ from: "1040", to: "40", reason: "Entered as 1040 by mistake", renamedDocuments: [{ id: doc.id, from: "2025 1040 — AL", to: "2025 40 — AL" }] });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: notice.id } })).title).toBe("Notice 10401 follow-up");
    const { text } = await tab(client.id, tabitha);
    expect(text.join(" ")).toMatch(/Form number/);
  });

  it("the same refusals: reason required, no same-number change, no duplicate filing", async () => {
    const { tabitha, client, al } = await setup();
    await expect(editFilingDetails(tabitha, al.id, al40, "   ")).rejects.toThrow(/Say why the form number/);
    await expect(editFilingDetails(tabitha, al.id, { ...al40, returnType: "1040" }, "same")).rejects.toThrow(/already/);
    await createFiling(tabitha, { clientId: client.id, taxYear: 2025, returnType: "40", jurisdiction: "AL", filingType: "ORIGINAL" });
    await expect(editFilingDetails(tabitha, al.id, al40, "Typo")).rejects.toThrow(/already has a 2025 form 40 filing for AL/);
    expect(await prisma.filingStatusEvent.count({ where: { filingId: al.id, field: { in: ["FORM", "DETAILS"] } } })).toBe(0);
  });

  it("form number plus another detail: the form part is recorded exactly as #124 does, the rest with #122's own audit", async () => {
    const { tabitha, al, doc } = await setup();
    const r = await editFilingDetails(tabitha, al.id, { ...al40, taxYear: 2024 }, "Entered as 2025 1040 by mistake");
    expect([r.taxYear, r.returnType, r.detailsCorrected]).toEqual([2024, "40", true]);
    const form = await prisma.filingStatusEvent.findFirstOrThrow({ where: { filingId: al.id, field: "FORM" } });
    expect([form.fromValue, form.toValue, form.verificationNote]).toEqual(["1040", "40", "Entered as 2025 1040 by mistake"]);
    const details = await prisma.filingStatusEvent.findFirstOrThrow({ where: { filingId: al.id, field: "DETAILS" } });
    expect([details.fromValue, details.toValue]).toEqual(["2025 AL 40 original", "2024 AL 40 original"]);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "filing.form_corrected", entityId: al.id } });
    expect((log.details as { renamedDocuments: unknown[] }).renamedDocuments).toEqual([{ id: doc.id, from: "2025 1040 — AL", to: "2025 40 — AL" }]);
    expect(await prisma.auditLog.count({ where: { action: "filing.details_corrected", entityId: al.id } })).toBe(1);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).title).toBe("2024 40 — AL");
  });

  it("other details only: #122's own audit, no FORM event", async () => {
    const { tabitha, al } = await setup();
    const r = await editFilingDetails(tabitha, al.id, { taxYear: 2024, returnType: "1040", jurisdiction: "AL", filingType: "ORIGINAL" }, "Wrong year");
    expect(r.formCorrection).toBeUndefined();
    expect(await prisma.filingStatusEvent.count({ where: { filingId: al.id, field: "FORM" } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "filing.form_corrected" } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "filing.details_corrected", entityId: al.id } })).toBe(1);
    await expect(editFilingDetails(tabitha, al.id, { taxYear: 2024, returnType: "1040", jurisdiction: "AL", filingType: "ORIGINAL" }, "again")).rejects.toThrow(/already the 2024 AL 1040 original/);
  });
});
