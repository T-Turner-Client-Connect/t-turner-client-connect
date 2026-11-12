import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";
import { makeUser, prisma, resetDb } from "./db";
import type { Actor } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { createFiling, setFilingStatusByStaff } from "@/lib/services/tax";
import { fileReturnForFiling } from "@/lib/services/accepted-returns";
import { taxSeasonProgress } from "@/lib/services/tax-season";
import { seasonSteps, type SeasonInput } from "@/lib/tax/season-steps";
import { TaxesTab } from "@/components/client-tabs/taxes";
import { DocumentsTab } from "@/components/client-tabs/documents";
import { setReturnGate } from "@/lib/services/return-gate";

// Placeholder PDFs here carry no return text; the return upload gate itself is tested in return-gate.test.ts.
beforeEach(() => setReturnGate(async () => "VERIFIED"));
afterEach(() => setReturnGate(null));

/** The staff Taxes tab in tax-season order (Step 1 → 2 → 3, then Filing history). Fictional client only. */
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

const fmt = (d: Date) => d.toISOString().slice(0, 10);
const base: SeasonInput = { year: 2025, questionnaireDone: false, documentsDone: false, summaryRequired: true, summaryApproved: false, ownerFilingRecorded: false, filings: [] };
const fed = { jurisdiction: "FEDERAL", filingType: "ORIGINAL", filingStatus: "NOT_SUBMITTED", prepStatus: "NOT_STARTED", returnSentAt: null };
const al = { ...fed, jurisdiction: "AL" };

describe("seasonSteps: which steps are done", () => {
  it("start of the season: nothing done, Step 1 is next", () => {
    expect(seasonSteps(base, fmt)).toMatchObject({ done: { info: false, prep: false, send: false }, next: "info", allDone: false, doneLine: null });
  });

  it("Step 1 needs both the questionnaire and the documents", () => {
    expect(seasonSteps({ ...base, questionnaireDone: true }, fmt).done.info).toBe(false);
    expect(seasonSteps({ ...base, questionnaireDone: true, documentsDone: true }, fmt)).toMatchObject({ done: { info: true }, next: "prep" });
  });

  it("Step 2: the client-approved summary, or Tabitha's recorded override; a business return without a summary once it's ready to file", () => {
    const info = { ...base, questionnaireDone: true, documentsDone: true, filings: [fed, al] };
    expect(seasonSteps(info, fmt).done.prep).toBe(false);
    expect(seasonSteps({ ...info, summaryApproved: true }, fmt)).toMatchObject({ done: { prep: true }, next: "send" });
    expect(seasonSteps({ ...info, ownerFilingRecorded: true }, fmt).done.prep).toBe(true);
    const biz = { ...info, summaryRequired: false, filings: [{ ...fed, prepStatus: "IN_PROGRESS" }] };
    expect(seasonSteps(biz, fmt).done.prep).toBe(false);
    expect(seasonSteps({ ...biz, filings: [{ ...fed, prepStatus: "READY_TO_FILE" }] }, fmt).done.prep).toBe(true);
  });

  it("Step 3: every return Accepted with its copy sent; extensions don't count", () => {
    const ready = { ...base, questionnaireDone: true, documentsDone: true, summaryApproved: true };
    const sent = new Date("2026-04-15T15:00:00Z");
    const accepted = { ...fed, filingStatus: "ACCEPTED", returnSentAt: sent };
    expect(seasonSteps({ ...ready, filings: [accepted, { ...al, filingStatus: "ACCEPTED" }] }, fmt)).toMatchObject({ done: { send: false }, next: "send" });
    expect(seasonSteps({ ...ready, filings: [accepted, { ...al, filingStatus: "SUBMITTED", returnSentAt: sent }] }, fmt).done.send).toBe(false);
    const all = seasonSteps({ ...ready, filings: [{ ...al, filingStatus: "ACCEPTED", returnSentAt: new Date("2026-04-14T15:00:00Z") }, accepted, { ...fed, filingType: "EXTENSION" }] }, fmt);
    expect(all).toMatchObject({ done: { info: true, prep: true, send: true }, next: null, allDone: true });
    expect(all.doneLine).toBe("2025: Federal + AL returns sent to client on 2026-04-15");
    expect(seasonSteps({ ...ready, filings: [accepted] }, fmt).doneLine).toBe("2025: Federal return sent to client on 2026-04-15");
  });

  it("no returns yet: Step 3 is never done", () => {
    expect(seasonSteps({ ...base, questionnaireDone: true, documentsDone: true, summaryApproved: true }, fmt)).toMatchObject({ done: { send: false }, next: "send" });
  });
});

type El = { type: unknown; props: Record<string, unknown> };
function walk(node: unknown, els: El[] = [], text: string[] = []) {
  if (Array.isArray(node)) for (const n of node) walk(n, els, text);
  else if (typeof node === "string" || typeof node === "number") text.push(String(node));
  else if (isValidElement(node)) {
    const el = node as unknown as El;
    els.push(el);
    for (const v of Object.values(el.props)) if (Array.isArray(v) || isValidElement(v) || typeof v === "string" || typeof v === "number") walk(v, els, text);
  }
  return { els, text };
}
const stepsOf = (els: El[]) => els.filter((e) => typeof e.type === "function" && (e.type as { name: string }).name === "Step").map((e) => ({ n: e.props.n ?? "history", done: e.props.done, open: e.props.open }));

async function office() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const client = await createClient(tabitha, { firstName: "Juniper", lastName: "Ashcombe", clientType: "INDIVIDUAL", status: "ACTIVE" });
  await prisma.client.update({ where: { id: client.id }, data: { state: "AL" } });
  return { tabitha, client };
}
const owner = { form8879Confirmed: true, overrideReason: "Prepared and e-filed in TaxAct before Client Connect summary approvals" };
const tab = async (clientId: string, user: Actor) => walk(await TaxesTab({ clientId, user, taxYear: 2025 }));

describe("The Taxes tab opens at the next step", () => {
  it("start of the season: Step 1 open, Filing history below", async () => {
    const { tabitha, client } = await office();
    const { els, text } = await tab(client.id, tabitha);
    expect(stepsOf(els)).toEqual([
      { n: 1, done: false, open: true },
      { n: 2, done: false, open: true },
      { n: 3, done: false, open: true },
      { n: "history", done: false, open: true },
    ]);
    expect(text.join(" ")).not.toMatch(/sent to client on/);
  });

  it("mid-way: Steps 1–2 collapse to ✓ Done, Step 3 is the first open section", async () => {
    const { tabitha, client } = await office();
    await prisma.questionnaireSubmission.create({ data: { clientId: client.id, taxYear: 2025, jotformFormId: "fictional", submissionId: "fictional-sub-1", source: "staff_import", documentIds: [] } });
    await prisma.taxYearProgress.create({ data: { clientId: client.id, taxYear: 2025, documentsStatus: "ALL_RECEIVED" } });
    const f = await createFiling(tabitha, { clientId: client.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    await createFiling(tabitha, { clientId: client.id, taxYear: 2025, returnType: "40", jurisdiction: "AL", filingType: "ORIGINAL" });
    await setFilingStatusByStaff(tabitha, f.id, { status: "SUBMITTED", verificationNote: "Filed in TaxAct (fictional)", submission: owner });
    expect((await taxSeasonProgress(client.id, 2025)).next).toBe("send");
    const { els } = await tab(client.id, tabitha);
    expect(stepsOf(els).slice(0, 3)).toEqual([
      { n: 1, done: true, open: false },
      { n: 2, done: true, open: false },
      { n: 3, done: false, open: true },
    ]);
  });

  it("fully done: one line “2025: Federal + AL returns sent to client on …”, everything else collapsed", async () => {
    const { tabitha, client } = await office();
    for (const [j, form] of [["FEDERAL", "1040"], ["AL", "40"]] as const) {
      const f = await createFiling(tabitha, { clientId: client.id, taxYear: 2025, returnType: form, jurisdiction: j, filingType: "ORIGINAL" });
      await setFilingStatusByStaff(tabitha, f.id, { status: "ACCEPTED", verificationNote: "Accepted per TaxAct (fictional)", submission: owner });
      await fileReturnForFiling(tabitha, f.id, { bytes: pdf(j), originalName: `${j}.pdf` });
    }
    const p = await taxSeasonProgress(client.id, 2025);
    expect(p.allDone).toBe(true);
    expect(p.doneLine).toMatch(/^2025: Federal \+ AL returns sent to client on [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    const { els, text } = await tab(client.id, tabitha);
    const line = els.find((e) => e.props["data-testid"] === "season-done");
    expect(line?.props.open).toBe(false);
    expect(text.join(" ")).toContain(p.doneLine);
    expect(stepsOf(els).every((s) => s.open === false && (s.n === "history" || s.done === true))).toBe(true);
  });

  it("a staff-only return waiting for Tabitha's release doesn't count as sent", async () => {
    const { tabitha, client } = await office();
    const daria = await makeUser("STAFF", "Daria");
    const f = await createFiling(tabitha, { clientId: client.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    await setFilingStatusByStaff(tabitha, f.id, { status: "ACCEPTED", verificationNote: "Accepted per TaxAct (fictional)", submission: owner });
    await fileReturnForFiling(daria, f.id, { bytes: pdf("staff"), originalName: "fed.pdf" });
    expect((await taxSeasonProgress(client.id, 2025)).done.send).toBe(false);
  });
});

describe("Documents tab: the same stored copy, labelled where it came from", () => {
  it("a return copy shows “Sent from Taxes tab”, an acknowledgment “Acceptance confirmation”, both link to the Taxes tab; the folder is “Taxes (returns & tax documents)”", async () => {
    const { tabitha, client } = await office();
    const f = await createFiling(tabitha, { clientId: client.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    await setFilingStatusByStaff(tabitha, f.id, { status: "ACCEPTED", verificationNote: "Accepted per TaxAct (fictional)", submission: owner });
    const ret = await fileReturnForFiling(tabitha, f.id, { bytes: pdf("ret"), originalName: "fed.pdf" });
    const { els, text } = walk(await DocumentsTab({ clientId: client.id, user: tabitha }));
    const all = text.join(" ");
    expect(all).toContain("Sent from Taxes tab");
    expect(all).toContain("Taxes (returns & tax documents)");
    const links = els.filter((e) => e.props["data-testid"] === "open-on-taxes");
    expect(links.map((e) => e.props.href)).toEqual([`/clients/${client.id}?tab=taxes&taxYear=2025`]);
    // One stored copy: the Taxes tab card lists the same document.
    expect(await prisma.document.count({ where: { clientId: client.id, filingDocType: "RETURN" } })).toBe(1);
    expect(ret.filingId).toBe(f.id);
    // An acknowledgment gets its own label.
    await prisma.document.update({ where: { id: ret.id }, data: { filingDocType: "OFFICIAL_ACK" } });
    const again = walk(await DocumentsTab({ clientId: client.id, user: tabitha })).text.join(" ");
    expect(again).toContain("Acceptance confirmation · from Taxes tab");
  });
});

describe("Only the needed items, in their place", () => {
  const actionNames = (els: El[]) => els.map((e) => (typeof e.props.action === "function" ? (e.props.action as { name: string }).name : "")).filter(Boolean);

  it("Add a filing lives only under Filing history › More options; no TaxAct or tax-profile cards on Taxes", async () => {
    const { tabitha, client } = await office();
    const { els, text } = await tab(client.id, tabitha);
    const all = text.join(" ");
    expect(all).not.toMatch(/TaxAct link|Tax profile \(drives deadline countdowns\)|My Tax Center — status by tax year|Identity documents on file/);
    const names = actionNames(els);
    expect(names.filter((n) => n === "bound createFilingAction")).toHaveLength(1);
    expect(names).not.toContain("bound setTaxSoftwareIdAction");
    expect(names).not.toContain("bound taxProfileAction");
    const more = els.find((e) => e.props["data-testid"] === "history-more-options")!;
    const inside = walk(more.props.children);
    expect(actionNames(inside.els)).toContain("bound createFilingAction");
    expect(inside.text.join(" ")).toContain("Add another filing (extension, amended, extra state)");
    // The client progress note (manual Documents, estimate, note) moved there too.
    expect(inside.els.some((e) => typeof e.type === "function" && (e.type as { name: string }).name === "ClientProgressNote")).toBe(true);
  });

  it("year header: TaxAct ID read-only (or a pointer to Overview) and the five-step strip", async () => {
    const { tabitha, client } = await office();
    let { text } = await tab(client.id, tabitha);
    expect(text.join(" ")).toMatch(/No TaxAct ID: .*add on Overview/);
    await prisma.client.update({ where: { id: client.id }, data: { taxSoftwareId: "12345" } });
    ({ text } = await tab(client.id, tabitha));
    expect(text.join(" ")).toContain("TaxAct ID 12345");
    const { yearStrip } = await import("@/lib/services/tax-season");
    const strip = await yearStrip(client.id, 2025);
    expect(strip.map((s) => s.label)).toEqual(["Questionnaire", "Documents", "Return preparation", "Filing", "Agency acceptance"]);
  });

  it("Documents in the strip come from the year's document requests when there are any; the client portal value is unchanged", async () => {
    const { tabitha, client } = await office();
    const { yearStrip } = await import("@/lib/services/tax-season");
    const { taxYearStatuses } = await import("@/lib/services/tax-center");
    await prisma.taxYearProgress.create({ data: { clientId: client.id, taxYear: 2025, documentsStatus: "SOME_RECEIVED" } });
    const docs = async () => (await yearStrip(client.id, 2025)).find((s) => s.key === "documents")!;
    expect((await docs()).value).toBe("Some documents received"); // manual value without requests
    const base = { clientId: client.id, createdById: tabitha.id, kind: "YEAR_END", taxYear: 2025, category: "TAXES" as const };
    await prisma.documentRequest.create({ data: { ...base, title: "W-2 (fictional employer)", status: "SUBMITTED" } });
    await prisma.documentRequest.create({ data: { ...base, title: "1099-INT (fictional bank)", status: "OPEN" } });
    await prisma.documentRequest.create({ data: { ...base, title: "Draft only", status: "DRAFT" } });
    expect(await docs()).toMatchObject({ value: "1 of 2 requested received", done: false });
    await prisma.documentRequest.updateMany({ where: { clientId: client.id, status: "OPEN" }, data: { status: "ACCEPTED" } });
    expect(await docs()).toMatchObject({ value: "All documents received", done: true });
    // The portal keeps reading the manual value, exactly as today.
    expect((await taxYearStatuses(client.id, [2025]))[0].steps.find((s) => s.key === "documents")!.value).toBe("Some documents received");
  });

  it("Step 1 shows one identity line only when something is missing", async () => {
    const { tabitha, client } = await office();
    const { identityGapLine } = await import("@/lib/services/tax-season");
    const { ensureClientPerson, uploadIdentityDocument, verifyIdentityDocument } = await import("@/lib/services/identity");
    const me = await ensureClientPerson(client.id);
    expect(await identityGapLine(client.id, tabitha)).toBe("Driver's license and Social Security card not on file");
    const day = new Date(Date.now() + 400 * 86400_000).toISOString().slice(0, 10);
    const dl = await uploadIdentityDocument({ staff: tabitha }, { clientId: client.id, personId: me.id, type: "DRIVERS_LICENSE", expiresOn: day, bytes: pdf("dl"), originalName: "dl.pdf" });
    await verifyIdentityDocument(tabitha, dl.id, {});
    expect(await identityGapLine(client.id, tabitha)).toBe("Social Security card not on file");
    const ss = await uploadIdentityDocument({ staff: tabitha }, { clientId: client.id, personId: me.id, type: "SOCIAL_SECURITY_CARD", bytes: pdf("ss"), originalName: "ss.pdf" });
    await verifyIdentityDocument(tabitha, ss.id, { last4: "0000" });
    expect(await identityGapLine(client.id, tabitha)).toBeNull();
  });
});
