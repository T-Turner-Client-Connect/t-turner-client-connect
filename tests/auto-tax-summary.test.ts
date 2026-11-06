import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { form8879Pages, jointCouple, jordan, returnPdf, toPdf } from "./fixtures/tax-return-fixture";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { createFiling, setFilingStatusByStaff } from "@/lib/services/tax";
import { approveSummary, portalSummaries, requestSummaryChanges, sendSummary, summaryRequirement, updateSummaryDraft } from "@/lib/services/tax-summary";
import { addItem, resolveCheck, sendBlockers, updateItem } from "@/lib/services/tax-summary-items";
import { ownerSwitches, setOwnerSwitch } from "@/lib/services/owner-switches";
import { portalDocuments } from "@/lib/services/documents";
import {
  autoSummaryPanel, form8879Progress, form8879StaffTitle, form8879Status, form8879VaultTitle, mark8879Sent, publishSigned8879ForYear, recordSigned8879, sendAutoSummaryForApproval,
  signed8879OnFile, summaryTracker, uploadPreparedReturn, type UploadOutcome,
} from "@/lib/services/auto-tax-summary";

// Every person, employer, account and amount here is fictional.
beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup(opts: { login?: boolean; first?: string; last?: string } = {}) {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const client = await createClient(tabitha, { firstName: opts.first ?? "Jordan", lastName: opts.last ?? "Sample", clientType: "INDIVIDUAL", status: "ACTIVE" });
  let jordanLogin: { id: string; name: string; email: string } | null = null;
  if (opts.login !== false) {
    const { token } = await invitePortalUser(tabitha, client.id, { email: `${(opts.first ?? "jordan").toLowerCase()}@fictional.example`, name: `${opts.first ?? "Jordan"} ${opts.last ?? "Sample"}`, role: "OWNER" });
    const login = await acceptPortalInvite(token!, "Fictional-Pass-12345");
    jordanLogin = { id: login.id, name: login.name, email: login.email };
  }
  return { tabitha, daria, client, login: jordanLogin! };
}
const upload = async (actor: Parameters<typeof uploadPreparedReturn>[0], clientId: string, bytes: Uint8Array, taxYear = 2025) => (await uploadPreparedReturn(actor, { clientId, taxYear, bytes, originalName: "return.pdf" })) as UploadOutcome;
const audits = (action: string) => prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });
const sign8879 = (o: Partial<Parameters<typeof form8879Pages>[0]> = {}) => toPdf(form8879Pages({ taxpayer: { first: "Jordan", last: "Sample" }, agi: 62000, totalTax: 0, withheld: 4800, refund: 4935, ...o }));

async function approvedJordan() {
  const ctx = await setup();
  const r = await upload(ctx.tabitha, ctx.client.id, await returnPdf(jordan()));
  await sendAutoSummaryForApproval(ctx.tabitha, r.summaryId!);
  await approveSummary(ctx.login, ctx.client.id, r.summaryId!, { role: "TAXPAYER", signerName: "Jordan Sample", agreed: true });
  return { ...ctx, summaryId: r.summaryId! };
}

describe("upload → checks → draft → Tabitha's one click", () => {
  it("switch OFF (default): every check passes, the draft waits for Tabitha; staff can't send it", async () => {
    const { tabitha, daria, client, login } = await setup();
    expect((await ownerSwitches()).taxSummaryAutoSend.on).toBe(false);
    const r = await upload(tabitha, client.id, await returnPdf(jordan()));
    expect(r).toMatchObject({ outcome: "READY", issues: [] });
    expect(r.waitingReason).toMatch(/is off/);
    const s = await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: r.summaryId! }, include: { items: true } });
    expect(s).toMatchObject({ status: "DRAFT", filingStatus: "HOH", taxpayerName: "Jordan Sample", agiCents: 6200000, deductionType: "STANDARD", deductionCents: 2362500, federalResultCents: 493500, depositAccountLast4: "4821", depositAccountType: "CHECKING" });
    expect(s.stateResults).toEqual([{ state: "AL", resultCents: 57800 }]);
    expect(s.dependents).toEqual([{ name: "Ava Sample", relationship: "Daughter", age: 9 }, { name: "Mason Sample", relationship: "Son", age: 6 }]);
    expect(s.items.map((i) => i.formType).sort()).toEqual(["AUTO-1040", "AUTO-8812", "AUTO-AL-40", "AUTO-AL-SCH-A", "AUTO-SCH-A"]);
    expect(s.items.every((i) => i.status === "VERIFIED")).toBe(true);
    // The existing send path is blocked until Tabitha's click.
    expect((await sendBlockers(s.id)).join(" ")).toMatch(/Waiting for Tabitha/);
    await expect(sendSummary(daria, s.id)).rejects.toThrow(/Waiting for Tabitha/);
    await expect(sendAutoSummaryForApproval(daria, s.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.notification.count()).toBe(0);
    // Tabitha's one click → the existing TAX_SUMMARY_READY sign-in notice, no figures.
    await sendAutoSummaryForApproval(tabitha, s.id);
    const n = await prisma.notification.findMany();
    expect(n.map((x) => x.kind)).toEqual(["TAX_SUMMARY_READY"]);
    expect(JSON.stringify(n)).not.toMatch(/4,?935|62,?000/);
    const seen = await portalSummaries(login, client.id);
    expect(seen.map((x) => x.id)).toEqual([s.id]);
    expect((await audits("tax.auto_summary_held")).map((a) => (a.details as { kind: string }).kind)).toEqual(["WAITING_FOR_OWNER"]);
    expect(await audits("tax.auto_summary_sent_by_owner")).toHaveLength(1);
  });

  it("switch ON: Tabitha's own upload with a portal login auto-sends; staff uploads and no-login clients wait", async () => {
    const { tabitha, daria, client } = await setup();
    await expect(setOwnerSwitch(daria, "taxSummaryAutoSend", true)).rejects.toBeInstanceOf(ForbiddenError);
    await setOwnerSwitch(tabitha, "taxSummaryAutoSend", true);
    expect((await audits("tax.summary_auto_send_on"))).toHaveLength(1);

    const staff = await upload(daria, client.id, await returnPdf(jordan()));
    expect(staff.outcome).toBe("READY");
    expect(staff.waitingReason).toMatch(/Uploaded by staff/);

    const own = await upload(tabitha, client.id, await returnPdf(jordan()));
    expect(own.outcome).toBe("AUTO_SENT");
    expect((await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: own.summaryId! } })).status).toBe("SENT");
    expect(await audits("tax.auto_summary_auto_sent")).toHaveLength(1);
    expect(await prisma.notification.count({ where: { kind: "TAX_SUMMARY_READY" } })).toBe(1);

    const other = await createClient(tabitha, { firstName: "Riley", lastName: "Example", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await prisma.client.update({ where: { id: other.id }, data: { spouseFirstName: "Casey", spouseLastName: "Example" } });
    const noLogin = await upload(tabitha, other.id, await returnPdf(jointCouple()));
    expect(noLogin.outcome).toBe("READY");
    expect(noLogin.waitingReason).toMatch(/no active portal login/);
  });

  it("re-uploading after approval revises: the earlier approval no longer counts", async () => {
    const { tabitha, client, summaryId } = await approvedJordan();
    const federal = await createFiling(tabitha, { clientId: client.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    expect((await summaryRequirement(federal)).approved?.id).toBe(summaryId);
    const r = await upload(tabitha, client.id, await returnPdf(jordan()));
    expect(r.outcome).toBe("READY");
    expect(r.summaryId).not.toBe(summaryId);
    expect((await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: summaryId } })).status).toBe("SUPERSEDED");
    expect(await prisma.taxSummarySignature.count({ where: { summaryId, invalidatedAt: null } })).toBe(0);
    expect((await summaryRequirement(federal)).approved).toBeNull();
  });

  it("the client's question puts it on hold (existing request-changes path)", async () => {
    const { tabitha, client, login } = await setup();
    const r = await upload(tabitha, client.id, await returnPdf(jordan()));
    await sendAutoSummaryForApproval(tabitha, r.summaryId!);
    await requestSummaryChanges(login, client.id, r.summaryId!, "Why is my Alabama refund smaller?");
    expect((await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: r.summaryId! } })).status).toBe("CHANGES_REQUESTED");
  });
});

describe("fail-safe: held, never sent", () => {
  it("name mismatch: nothing is stored, the reason waits for Tabitha (never one client's summary for another)", async () => {
    const { tabitha, client } = await setup({ first: "Marcus", last: "Fairbanks" });
    await setOwnerSwitch(tabitha, "taxSummaryAutoSend", true);
    const r = await upload(tabitha, client.id, await returnPdf(jordan()));
    expect(r.outcome).toBe("HELD");
    expect(r.issues.map((i) => i.code)).toContain("NAME_MISMATCH");
    expect(await prisma.taxReturnSummary.count()).toBe(0);
    expect(await prisma.document.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
    const held = await audits("tax.auto_summary_held");
    expect((held[0].details as { kind: string; fileSaved: boolean }).kind).toBe("CHECKS_FAILED");
    const panel = await autoSummaryPanel(client.id);
    expect(panel.years[0].held?.issues[0].message).toMatch(/doesn't match this client/);
  });

  it("a missing line or math mismatch: held with a plain list; an earlier automatic draft is withdrawn", async () => {
    const { tabitha, client } = await setup();
    await setOwnerSwitch(tabitha, "taxSummaryAutoSend", true);
    const missing = await upload(tabitha, client.id, await returnPdf(jordan({ drop: ["1040.24"] })));
    expect(missing.outcome).toBe("HELD");
    expect(missing.issues[0].message).toBe("Form 1040, line 24 (Total tax): not found on the return.");
    expect(await prisma.taxReturnSummary.count()).toBe(0);

    const ok = await upload(tabitha, client.id, await returnPdf(jordan()));
    expect(ok.outcome).toBe("AUTO_SENT");
    const bad = await upload(tabitha, client.id, await returnPdf(jordan({ v: { "1040.35a": 4936 } })));
    expect(bad.outcome).toBe("HELD");
    expect(bad.issues.map((i) => i.code)).toContain("MATH_REFUND");
    // The sent summary isn't touched by a failed upload; nothing new was sent.
    expect((await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: ok.summaryId! } })).status).toBe("SENT");
    expect(await prisma.notification.count({ where: { kind: "TAX_SUMMARY_READY" } })).toBe(1);
  });

  it("tax year mismatch and business returns are held", async () => {
    const { tabitha, client } = await setup();
    expect((await upload(tabitha, client.id, await returnPdf(jordan({ year: 2024 })))).issues.map((i) => i.code)).toContain("YEAR_MISMATCH");
    const biz = await upload(tabitha, client.id, await toPdf([["Form 1120-S U.S. Income Tax Return for an S Corporation 2025", "Name Sample Widgets LLC"]]));
    expect(biz.issues[0].message).toBe("Business return summaries aren't supported yet (Form 1120-S found). Phase 2.");
  });

  it("an automatic draft can't be edited by hand, its checks can't be resolved, and hand-edited figures block the send", async () => {
    const { tabitha, daria, client } = await setup();
    const r = await upload(daria, client.id, await returnPdf(jordan()));
    const item = await prisma.taxSummaryItem.findFirstOrThrow({ where: { summaryId: r.summaryId! } });
    await expect(updateItem(daria, item.id, { section: "OTHER", formType: "W-2", payerName: "X", recipient: "TAXPAYER", returnAmounts: [{ key: "w", label: "w", cents: 1 }] }, "test")).rejects.toThrow(/automatic summary/);
    await expect(addItem(daria, r.summaryId!, { section: "INCOME", formType: "W-2", payerName: "Acme", recipient: "TAXPAYER", returnAmounts: [{ key: "w", label: "w", cents: 1 }] })).rejects.toThrow(/automatic summary/);
    const check = await prisma.taxSummaryCheck.findFirstOrThrow({ where: { summaryId: r.summaryId! } });
    await expect(resolveCheck(daria, check.id, "skip it")).rejects.toThrow(/can't be resolved by hand/);
    const s = await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: r.summaryId! } });
    await updateSummaryDraft(daria, s.id, { filingStatus: s.filingStatus, taxpayerName: s.taxpayerName, spouseName: null, dependents: [], wagesCents: s.wagesCents, otherIncomeCents: 0, totalIncomeCents: s.totalIncomeCents, agiCents: s.agiCents, deductionType: "STANDARD", deductionCents: s.deductionCents, taxableIncomeCents: s.taxableIncomeCents, federalResultCents: 999900, stateResults: [{ state: "AL", resultCents: 57800 }], depositAccountType: "CHECKING", depositRoutingLast4: "0019", depositAccountLast4: "4821" });
    await expect(sendAutoSummaryForApproval(tabitha, s.id)).rejects.toThrow(/changed by hand/);
  });
});

describe("joint return and the owner filing gate", () => {
  it("both spouses sign; the gate sees the approved automatic summary", async () => {
    const { tabitha, client, login } = await setup({ first: "Riley", last: "Example" });
    await prisma.client.update({ where: { id: client.id }, data: { spouseFirstName: "Casey", spouseLastName: "Example" } });
    const r = await upload(tabitha, client.id, await returnPdf(jointCouple()));
    expect(r.outcome).toBe("READY");
    await sendAutoSummaryForApproval(tabitha, r.summaryId!);
    expect((await approveSummary(login, client.id, r.summaryId!, { role: "TAXPAYER", signerName: "Riley Example", agreed: true })).complete).toBe(false);
    const federal = await createFiling(tabitha, { clientId: client.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    expect((await summaryRequirement(federal)).approved).toBeNull();
    expect((await approveSummary(login, client.id, r.summaryId!, { role: "SPOUSE", signerName: "Casey Example", agreed: true })).complete).toBe(true);
    expect((await summaryRequirement(federal)).approved?.id).toBe(r.summaryId);
    await setFilingStatusByStaff(tabitha, federal.id, { status: "SUBMITTED", submission: { form8879Confirmed: true } });
  });
});

describe("Form 8879 after approval", () => {
  it("waiting → sent → signed; satisfies the filing gate without the checkbox; titles use the return's tax year", async () => {
    const { tabitha, daria, client, summaryId } = await approvedJordan();
    const federal = await createFiling(tabitha, { clientId: client.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    const st = async () => form8879Status(await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: summaryId } })).status;
    expect(await st()).toBe("WAITING");
    expect(await signed8879OnFile(federal)).toBe(false);
    await expect(setFilingStatusByStaff(tabitha, federal.id, { status: "SUBMITTED", submission: { form8879Confirmed: false } })).rejects.toThrow(/8879/);
    await mark8879Sent(daria, summaryId);
    expect(await st()).toBe("SENT");
    const notes = await prisma.notification.count();
    // Detected as an 8879 through the same upload box.
    const r = await uploadPreparedReturn(daria, { clientId: client.id, taxYear: 2025, bytes: await sign8879(), originalName: "8879-signed.pdf" });
    expect(r).toMatchObject({ outcome: "FORM_8879", status: "SIGNED", flags: [] });
    expect(await st()).toBe("SIGNED");
    expect(await prisma.notification.count()).toBe(notes); // no client message from this step
    const doc = await prisma.document.findFirstOrThrow({ where: { filingDocType: "SIGNED_8879" } });
    expect(doc).toMatchObject({ clientId: client.id, category: "TAXES", year: 2025, visibility: "STAFF_ONLY", filingId: federal.id, docType: "FORM_8879" });
    // Return year 2025, signed in 2026: the label carries the RETURN's year.
    expect(doc.title).toBe(form8879StaffTitle(2025, doc.createdAt));
    expect(doc.title).toMatch(/^Form 8879 — Tax Year 2025 \(signed [A-Z][a-z]{2} \d{1,2}, 2026\)$/);
    expect(form8879StaffTitle(2026, new Date("2027-03-01T18:00:00Z"))).toBe("Form 8879 — Tax Year 2026 (signed Mar 1, 2027)");
    expect(form8879VaultTitle(2026)).toBe("Form 8879 — Tax Year 2026 (signed)");
    expect(form8879Progress(2026, new Date("2027-03-01T18:00:00Z"))).toBe("8879 signed for Tax Year 2026 on Mar 1, 2027");
    expect(await signed8879OnFile(federal)).toBe(true);
    await setFilingStatusByStaff(tabitha, federal.id, { status: "SUBMITTED", submission: { form8879Confirmed: false } });
    expect((await prisma.filingRecord.findUniqueOrThrow({ where: { id: federal.id } })).filingStatus).toBe("SUBMITTED");
  });

  it("an 8879 before approval, or with different numbers, is flagged for Tabitha", async () => {
    const { tabitha, client } = await setup();
    const r = await upload(tabitha, client.id, await returnPdf(jordan()));
    await sendAutoSummaryForApproval(tabitha, r.summaryId!);
    const early = await recordSigned8879(tabitha, { clientId: client.id, taxYear: 2025, bytes: await sign8879(), originalName: "early.pdf" });
    expect(early.status).toBe("MISMATCH");
    expect(early.flags[0]).toBe("8879 numbers don't match the approved summary: it was uploaded before the client approved the summary.");

  });

  it("an 8879 whose numbers differ from the approved summary is flagged and doesn't satisfy the gate", async () => {
    const ok = await approvedJordan();
    const wrong = await recordSigned8879(ok.daria, { clientId: ok.client.id, taxYear: 2025, bytes: await sign8879({ agi: 61000 }), originalName: "wrong.pdf" });
    expect(wrong.flags).toEqual(["8879 numbers don't match the approved summary: adjusted gross income on the 8879 is $61,000, the summary shows $62,000."]);
    const federal = await createFiling(ok.tabitha, { clientId: ok.client.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    expect(await signed8879OnFile(federal)).toBe(false);
    expect(await audits("tax.form8879_flagged")).toHaveLength(1);
  });

  it("another person's 8879 or the wrong year is refused and not stored; only Tabitha marks an unrecognized file by hand", async () => {
    const { tabitha, daria, client } = await approvedJordan();
    await expect(recordSigned8879(daria, { clientId: client.id, taxYear: 2025, bytes: await sign8879({ taxpayer: { first: "Marcus", last: "Fairbanks" } }), originalName: "x.pdf" })).rejects.toThrow(/doesn't match this client/);
    await expect(recordSigned8879(daria, { clientId: client.id, taxYear: 2025, bytes: await sign8879({ year: 2024 }), originalName: "x.pdf" })).rejects.toThrow(/for 2024, not 2025/);
    const plain = await toPdf([["A scanned signature page"]]);
    await expect(recordSigned8879(daria, { clientId: client.id, taxYear: 2025, bytes: plain, originalName: "x.pdf" })).rejects.toThrow(/wasn't recognized/);
    await expect(recordSigned8879(daria, { clientId: client.id, taxYear: 2025, bytes: plain, originalName: "x.pdf", manual: true })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.document.count({ where: { filingDocType: "SIGNED_8879" } })).toBe(0);
    const manual = await recordSigned8879(tabitha, { clientId: client.id, taxYear: 2025, bytes: plain, originalName: "x.pdf", manual: true });
    expect(manual.status).toBe("SIGNED");
  });

  it("revising the summary after signing → Needs re-signing on staff and portal; history is kept, nothing deleted", async () => {
    const { tabitha, daria, client, login, summaryId } = await approvedJordan();
    await mark8879Sent(daria, summaryId);
    await recordSigned8879(daria, { clientId: client.id, taxYear: 2025, bytes: await sign8879(), originalName: "8879.pdf" });
    const r = await upload(tabitha, client.id, await returnPdf(jordan()));
    const v2 = await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: r.summaryId! } });
    expect(form8879Status(v2).status).toBe("NEEDS_RESIGN");
    await sendAutoSummaryForApproval(tabitha, v2.id);
    const portal = (await portalSummaries(login, client.id))[0];
    expect(form8879Status(portal).status).toBe("NEEDS_RESIGN");
    const panel = await autoSummaryPanel(client.id);
    expect(panel.years[0].form8879?.status).toBe("NEEDS_RESIGN");
    await approveSummary(login, client.id, v2.id, { role: "TAXPAYER", signerName: "Jordan Sample", agreed: true });
    await mark8879Sent(daria, v2.id);
    const after = await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: v2.id } });
    expect(form8879Status(after).status).toBe("SENT");
    expect((await autoSummaryPanel(client.id)).years[0].history.map((h) => h.event)).toEqual(["SENT", "SIGNED", "SENT_FOR_RESIGNING"]);
    expect(await prisma.document.count({ where: { filingDocType: "SIGNED_8879", deletedAt: null } })).toBe(1);
  });
});

describe("delivering the signed 8879 with the return", () => {
  it("not in the client's vault before the return is sent; published after; never visible to another client", async () => {
    const { tabitha, client, login } = await approvedJordan();
    const { documentId } = await recordSigned8879(tabitha, { clientId: client.id, taxYear: 2025, bytes: await sign8879(), originalName: "8879.pdf" });
    const vault = async (u: typeof login, cid: string) => (await portalDocuments(u, cid)).map((d) => d.title);
    expect(await vault(login, client.id)).not.toContain(form8879VaultTitle(2025));
    expect(await publishSigned8879ForYear(client.id, 2025, tabitha.id)).toEqual({ published: 0 }); // no return delivered yet

    // The year's return is delivered (Tax returns → release).
    const ret = await prisma.document.create({ data: { client: { connect: { id: client.id } }, category: "TAXES", title: "2025 1040 — Federal", year: 2025, visibility: "PUBLISHED", publishedAt: new Date(), filingDocType: "RETURN", reviewStatus: "APPROVED", scanStatus: "CLEAN", file: { create: { kind: "CLIENT_DOCUMENT", storageKey: "k-ret", originalName: "r.pdf", title: "r", mimeType: "application/pdf", sizeBytes: 1 } } } });
    expect(await publishSigned8879ForYear(client.id, 2025, tabitha.id)).toEqual({ published: 1 });
    const d = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(d).toMatchObject({ visibility: "PUBLISHED", title: "Form 8879 — Tax Year 2025 (signed)" });
    expect(await vault(login, client.id)).toEqual(expect.arrayContaining(["Form 8879 — Tax Year 2025 (signed)", ret.title]));

    // Another client (and their login) never sees it.
    const other = await createClient(tabitha, { firstName: "Riley", lastName: "Example", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const { token } = await invitePortalUser(tabitha, other.id, { email: "riley@fictional.example", name: "Riley Example", role: "OWNER" });
    const riley = await acceptPortalInvite(token!, "Fictional-Pass-12345");
    expect(await vault({ id: riley.id, name: riley.name, email: riley.email }, other.id)).not.toContain(form8879VaultTitle(2025));
    await expect(portalDocuments({ id: riley.id, name: riley.name, email: riley.email }, client.id)).rejects.toThrow();
    expect(await publishSigned8879ForYear(other.id, 2025, tabitha.id)).toEqual({ published: 0 });
  });
});

describe("8879 Signature Page tracker", () => {
  it("one row per client, needing-Tabitha first, filters and link targets", async () => {
    const a = await approvedJordan(); // approved, 8879 waiting → needs her
    const b = await createClient(a.tabitha, { firstName: "Marcus", lastName: "Fairbanks", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await upload(a.tabitha, b.id, await returnPdf(jordan())); // held: name mismatch
    const c = await createClient(a.tabitha, { firstName: "Riley", lastName: "Example", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await prisma.client.update({ where: { id: c.id }, data: { spouseFirstName: "Casey", spouseLastName: "Example" } });
    const cr = await upload(a.tabitha, c.id, await returnPdf(jointCouple()));
    await prisma.taxSummaryCheck.deleteMany({ where: { summaryId: cr.summaryId! } });
    await prisma.taxReturnSummary.update({ where: { id: cr.summaryId! }, data: { status: "SENT" } }); // sent, waiting for the client

    const rows = await summaryTracker(a.tabitha, 2025);
    expect(rows.map((r) => [r.clientName, r.summary.code, r.form8879.code, r.needsAction])).toEqual([
      ["Marcus Fairbanks", "HELD", "NONE", true],
      ["Jordan Sample", "APPROVED", "WAITING", true],
      ["Riley Example", "SENT", "NONE", false],
    ]);
    const j = rows[1];
    expect(j.taxYear).toBe(2025);
    expect(j.clientHref).toBe(`/clients/${a.client.id}?tab=taxes#auto-summary-2025`);
    expect(j.statusHref).toBe(j.clientHref); // waiting → the client's summary and 8879 panel
    expect(j.recordsHref).toBe(`/clients/${a.client.id}?tab=documents#docs-TAXES-2025`);
    expect((await summaryTracker(a.tabitha, 2025, "HELD")).map((r) => r.clientName)).toEqual(["Marcus Fairbanks"]);
    expect((await summaryTracker(a.tabitha, 2025, "8879_WAITING")).map((r) => r.clientName)).toEqual(["Jordan Sample"]);
    expect(await summaryTracker(a.tabitha, 2024)).toEqual([]);

    // Signed → the status opens the PDF through the secure staff link.
    await recordSigned8879(a.daria, { clientId: a.client.id, taxYear: 2025, bytes: await sign8879(), originalName: "8879.pdf" });
    const signed = (await summaryTracker(a.daria, 2025, "8879_SIGNED"))[0];
    expect(signed.form8879.label).toBe("Signed ✓");
    expect(signed.signedOn).toBeInstanceOf(Date);
    expect(signed.statusHref).toMatch(/^\/api\/documents\/.+/);
    expect(signed.noAccess).toBe(false);
    expect(signed.needsAction).toBe(false);
  });
});
