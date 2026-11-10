import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { categorizeBankTransaction, importBankCsv, setupLedger } from "@/lib/services/ledger";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { approveCoethaProposal, assertCanApproveCoethaWork, COETHA_NO_KEY, COETHA_OFF, coethaView, decideCoethaProposals, rejectCoethaProposal, runCoetha, runDailyCoetha, scrub } from "@/lib/services/coetha";

// A local stand-in for Anthropic's Messages API. Nothing leaves this test: any other host fails.
// Fictional businesses, people and transactions only.
type Input = { toCategorize: { ref: string; description: string; amount: number; bankAccount: string }[]; recentPosted: { ref: string }[]; monthToClose: string; chartOfAccounts: { code: string }[] };
let sent: string[] = [];
let mode: "ok" | "refusal" | "error" = "ok";
let extra: { categories?: unknown[]; adjustingEntries?: unknown[] } = {};

function answer(input: Input) {
  const cat = (t: Input["toCategorize"][number]) => (/OFFICE/.test(t.description) ? "6300" : /SOFTWARE/.test(t.description) ? "6600" : /ATM|OWNER/.test(t.description) ? "3100" : "9999");
  return {
    categories: [...input.toCategorize.map((t) => ({ ref: t.ref, accountCode: cat(t), confidence: cat(t) === "9999" ? 0.3 : 0.92, reason: `Looks like ${cat(t)}` })), ...((extra.categories as object[]) ?? [])],
    discrepancies: [{ type: "OWNER_DRAW_VS_EXPENSE", severity: "MEDIUM", title: "Cash withdrawal", detail: "An ATM withdrawal may be an owner draw.", refs: input.toCategorize.filter((t) => /ATM/.test(t.description)).map((t) => t.ref) }],
    adjustingEntries: [
      { date: `${input.monthToClose}-28`, memo: "Reclassify prepaid insurance", reason: "Part of the premium covers next year.", confidence: 0.7, lines: [{ accountCode: "1500", debit: 100, credit: 0, description: "Prepaid" }, { accountCode: "6200", debit: 0, credit: 100, description: "Insurance" }] },
      ...((extra.adjustingEntries as object[]) ?? []),
    ],
    monthSummary: { month: input.monthToClose, summary: "October was quiet: a few supply purchases and one cash withdrawal to review.", highlights: ["3 transactions to categorize"] },
  };
}

beforeEach(async () => {
  await resetDb();
  sent = []; mode = "ok"; extra = {};
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-fictional-key";
  delete process.env.COETHA_MODEL;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    if (u.host !== "api.anthropic.com" || u.pathname !== "/v1/messages") throw new Error(`Unexpected request: ${u.href}`);
    const body = String(init?.body ?? "");
    sent.push(body);
    const req = JSON.parse(body);
    const headers = { "content-type": "application/json", "request-id": "req_fictional_1" };
    if (mode === "error") return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } }), { status: 400, headers });
    const input = JSON.parse(req.messages[0].content.replace(/^[^\n]*\n/, "")) as Input;
    const content = mode === "refusal" ? [] : [{ type: "text", text: JSON.stringify(answer(input)) }];
    return new Response(JSON.stringify({ id: "msg_fictional", type: "message", role: "assistant", model: req.model, content, stop_reason: mode === "refusal" ? "refusal" : "end_turn", stop_sequence: null, usage: { input_tokens: 1800, output_tokens: 420 } }), { status: 200, headers });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
});

const CSV = (rows: string[]) => ["Date,Description,Amount", ...rows].join("\n");

async function setup({ on = true } = {}) {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const admin = await makeUser("ADMIN", "Second Admin");
  const daria = await makeUser("STAFF", "Daria");
  const stranger = await makeUser("STAFF", "Stranger");
  const vessel = await createClient(tabitha, { businessName: "Vessel Example LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id, email: "owner@vessel.example" });
  const harbor = await createClient(tabitha, { businessName: "Harbor Example Co (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(vessel.id, harbor.id);
  for (const c of [vessel, harbor]) await setupLedger(tabitha, c.id, { basis: "CASH" });
  const acct = async (clientId: string, code: string) => (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId, code } })).id;
  const checking = await acct(vessel.id, "1000");
  await importBankCsv(daria, vessel.id, checking, { fileName: "oct.csv", text: CSV(["10/02/2026,OFFICE DEPOT #1123,-84.20", "10/05/2026,ADOBE SOFTWARE SUB,-54.99", "10/09/2026,ATM WITHDRAWAL 987654321 REF 123-45-6789,-300.00"]) });
  await importBankCsv(tabitha, harbor.id, await acct(harbor.id, "1000"), { fileName: "h.csv", text: CSV(["10/03/2026,SECRETHARBORVENDOR PAYMENT,-999.00"]) });
  if (on) await setOwnerSwitch(tabitha, "coetha", true);
  return { tabitha, admin, daria, stranger, vessel, harbor, acct, checking };
}
const opts = { month: "2026-10", today: "2026-11-04" };
const open = (clientId: string, kind?: string) => prisma.coethaProposal.findMany({ where: { clientId, status: "PROPOSED", ...(kind ? { kind } : {}) }, orderBy: { createdAt: "asc" } });

describe("Coetha switch and API key", () => {
  it("is off by default; only Tabitha turns it on (audited); nothing is sent while it's off", async () => {
    const s = await setup({ on: false });
    await expect(runCoetha(s.daria, s.vessel.id, opts)).rejects.toThrow(COETHA_OFF);
    await expect(setOwnerSwitch(s.admin, "coetha", true)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setOwnerSwitch(s.daria, "liveBanking", true)).rejects.toBeInstanceOf(ForbiddenError);
    expect(sent).toHaveLength(0);
    await setOwnerSwitch(s.tabitha, "coetha", true);
    expect(await prisma.auditLog.count({ where: { action: "coetha.enabled_on", actorId: s.tabitha.id } })).toBe(1);
    expect(await prisma.ownerAuditLog.count({ where: { action: "coetha.enabled_on" } })).toBe(1);
    await runCoetha(s.daria, s.vessel.id, opts);
    expect(sent).toHaveLength(1);
    // CSV-imported rows count: Harbor (never run) is picked; Vessel ran just now and waits 20 hours.
    expect((await runDailyCoetha()).ran).toBe(1);
    expect(await prisma.coethaRun.count({ where: { clientId: s.harbor.id, trigger: "DAILY" } })).toBe(1);
    expect(await prisma.coethaRun.count({ where: { clientId: s.vessel.id, trigger: "DAILY" } })).toBe(0);
  });

  it("without ANTHROPIC_API_KEY it says so, sends nothing, and the books keep working", async () => {
    const s = await setup();
    delete process.env.ANTHROPIC_API_KEY;
    await expect(runCoetha(s.daria, s.vessel.id, opts)).rejects.toThrow(COETHA_NO_KEY);
    expect(COETHA_NO_KEY).toBe("Coetha needs an Anthropic API key — add ANTHROPIC_API_KEY in Netlify.");
    const v = await coethaView(s.daria, s.vessel.id);
    expect(v.status).toMatchObject({ enabled: true, keyPresent: false, ready: false });
    expect(await runDailyCoetha()).toMatchObject({ ran: 0, skipped: "no API key" });
    expect(sent).toHaveLength(0);
    const row = await prisma.bankTransaction.findFirstOrThrow({ where: { clientId: s.vessel.id, description: { contains: "OFFICE" } } });
    await categorizeBankTransaction(s.daria, s.vessel.id, row.id, { accountId: await s.acct(s.vessel.id, "6300") });
    expect(await prisma.journalEntry.count({ where: { clientId: s.vessel.id } })).toBe(1);
  });
});

describe("a Coetha run", () => {
  it("drafts proposals from this client's data only, minimized, and posts nothing", async () => {
    const s = await setup();
    extra = {
      categories: [{ ref: "T99", accountCode: "6300", confidence: 0.9, reason: "unknown row" }, { ref: "T1", accountCode: "0000", confidence: 0.9, reason: "duplicate ref and unknown account" }],
      adjustingEntries: [{ date: "2026-10-28", memo: "Unbalanced", reason: "x", confidence: 0.5, lines: [{ accountCode: "6300", debit: 10, credit: 0, description: "" }, { accountCode: "1000", debit: 0, credit: 9, description: "" }] }],
    };
    const r = await runCoetha(s.daria, s.vessel.id, opts);
    expect(r).toMatchObject({ proposals: 6, dropped: 3 });
    // Isolation and minimization: only this client's rows; no other client, no names, emails or ID numbers.
    const body = sent[0];
    expect(body).toContain("OFFICE DEPOT");
    expect(body).not.toContain("SECRETHARBORVENDOR");
    expect(body).not.toContain("Harbor Example");
    expect(body).not.toContain("Vessel Example");
    expect(body).not.toContain("owner@vessel.example");
    expect(body).not.toContain("123-45-6789");
    expect(body).not.toContain("987654321");
    const req = JSON.parse(body);
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(req.output_config.format.type).toBe("json_schema");
    const input = JSON.parse(req.messages[0].content.replace(/^[^\n]*\n/, ""));
    expect(input.toCategorize).toHaveLength(3);
    // The run log.
    const run = await prisma.coethaRun.findFirstOrThrow({ where: { clientId: s.vessel.id } });
    expect(run).toMatchObject({ status: "OK", trigger: "MANUAL", startedById: s.daria.id, model: "claude-sonnet-5-5", transactions: 3, proposals: 6, inputTokens: 1800, outputTokens: 420, requestId: expect.stringMatching(/^(req_fictional_1|msg_fictional)$/) });
    expect(run.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.error).toMatch(/3 suggestions/);
    const props = await open(s.vessel.id);
    expect(props.map((p) => p.kind).sort()).toEqual(["ADJUSTING_ENTRY", "CATEGORY", "CATEGORY", "CATEGORY", "DISCREPANCY", "MONTH_SUMMARY"]);
    expect(props.every((p) => p.runId === run.id && p.inputHash === run.inputHash && p.model === "claude-sonnet-5-5")).toBe(true);
    const office = props.find((p) => p.kind === "CATEGORY" && (p.payload as { description: string }).description.includes("OFFICE"))!;
    expect(office).toMatchObject({ confidence: 0.92, reason: "Looks like 6300" });
    expect((office.payload as { accountId: string }).accountId).toBe(await s.acct(s.vessel.id, "6300"));
    const disc = props.find((p) => p.kind === "DISCREPANCY")!;
    const atm = await prisma.bankTransaction.findFirstOrThrow({ where: { clientId: s.vessel.id, description: { contains: "ATM" } } });
    expect((disc.payload as { bankTransactionIds: string[] }).bankTransactionIds).toEqual([atm.id]);
    // Nothing touched the books, and the other client has nothing at all.
    expect(await prisma.journalEntry.count()).toBe(0);
    expect(await prisma.bankTransaction.count({ where: { status: { not: "UNREVIEWED" } } })).toBe(0);
    expect(await prisma.coethaProposal.count({ where: { clientId: s.harbor.id } })).toBe(0);
    // Someone who can't open this client's books can't run Coetha on it.
    await expect(runCoetha(s.stranger, s.vessel.id, opts)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a new run replaces open drafts; a failed answer is recorded and creates nothing", async () => {
    const s = await setup();
    await runCoetha(s.daria, s.vessel.id, opts);
    await runCoetha(s.daria, s.vessel.id, opts);
    expect(await prisma.coethaProposal.count({ where: { clientId: s.vessel.id, status: "SUPERSEDED" } })).toBe(6);
    expect(await open(s.vessel.id)).toHaveLength(6);
    mode = "refusal";
    await expect(runCoetha(s.daria, s.vessel.id, opts)).rejects.toThrow(/declined/);
    mode = "error";
    await expect(runCoetha(s.daria, s.vessel.id, opts)).rejects.toThrow(/rejected the request/);
    const failed = await prisma.coethaRun.findMany({ where: { clientId: s.vessel.id, status: "FAILED" } });
    expect(failed.map((f) => f.error?.split(":")[0]).sort()).toEqual(["BAD_REQUEST", "REFUSAL"]);
    expect(await open(s.vessel.id)).toHaveLength(6); // the last good drafts stay
  });

  it("scrubs identifiers from descriptions", () => {
    expect(scrub("ZELLE TO jane@example.com 555-201-3344 ACCT 000123456789 SSN 123-45-6789 EIN 12-3456789")).toBe("ZELLE TO [email] [phone] ACCT …6789 SSN [id] EIN [id]");
  });
});

describe("approving Coetha's work", () => {
  it("staff can view but never approve or reject, even as Admin; Tabitha can", async () => {
    const s = await setup();
    await runCoetha(s.daria, s.vessel.id, opts);
    const [p] = await open(s.vessel.id, "CATEGORY");
    expect((await coethaView(s.daria, s.vessel.id)).open).toHaveLength(6);
    // Every account a draft can point to is offered for editing (accounts without a subtype too), never Opening Balance Equity.
    const codes = (await coethaView(s.tabitha, s.vessel.id)).accounts.map((a) => a.code);
    expect(codes).toEqual(expect.arrayContaining(["1000", "3100", "6300", "6600", "9999"]));
    expect(codes).not.toContain("3900");
    expect((await coethaView(s.daria, s.vessel.id)).canApprove).toBe(false);
    for (const who of [s.daria, s.admin]) {
      await expect(approveCoethaProposal(who, s.vessel.id, p.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(rejectCoethaProposal(who, s.vessel.id, p.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(decideCoethaProposals(who, s.vessel.id, "APPROVE", [{ id: p.id }])).rejects.toBeInstanceOf(ForbiddenError);
      await expect(assertCanApproveCoethaWork(who)).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(coethaView(s.stranger, s.vessel.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.journalEntry.count()).toBe(0);
    expect((await prisma.coethaProposal.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PROPOSED");
    await assertCanApproveCoethaWork(s.tabitha);
    expect((await approveCoethaProposal(s.tabitha, s.vessel.id, p.id)).result).toBe("APPROVED");
  });

  it("approval posts exactly one entry; approving again is idempotent; the audit names Tabitha", async () => {
    const s = await setup();
    await runCoetha(s.daria, s.vessel.id, opts);
    const p = (await open(s.vessel.id, "CATEGORY")).find((x) => (x.payload as { description: string }).description.includes("OFFICE"))!;
    const first = await approveCoethaProposal(s.tabitha, s.vessel.id, p.id);
    expect(first.result).toBe("APPROVED");
    const again = await approveCoethaProposal(s.tabitha, s.vessel.id, p.id);
    expect(again).toMatchObject({ result: "ALREADY_APPROVED", journalEntryId: first.journalEntryId });
    // Two at the same moment still post once.
    await Promise.all([approveCoethaProposal(s.tabitha, s.vessel.id, p.id), approveCoethaProposal(s.tabitha, s.vessel.id, p.id)]);
    const entries = await prisma.journalEntry.findMany({ where: { clientId: s.vessel.id }, include: { lines: true } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: first.journalEntryId, source: "BANK", createdById: s.tabitha.id });
    expect(entries[0].lines.find((l) => l.debitCents === 8420)!.accountId).toBe(await s.acct(s.vessel.id, "6300"));
    expect(await prisma.bankTransaction.findUniqueOrThrow({ where: { id: p.bankTransactionId! } })).toMatchObject({ status: "POSTED", journalEntryId: first.journalEntryId, reviewedById: s.tabitha.id });
    expect(await prisma.coethaProposal.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ status: "APPROVED", decidedById: s.tabitha.id, journalEntryId: first.journalEntryId });
    const log = await prisma.auditLog.findMany({ where: { action: "coetha.proposal_approved" } });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actorId: s.tabitha.id, entityId: p.id, clientId: s.vessel.id });
  });

  it("Tabitha can change the category before approving (recorded as edited)", async () => {
    const s = await setup();
    await runCoetha(s.daria, s.vessel.id, opts);
    const p = (await open(s.vessel.id, "CATEGORY")).find((x) => (x.payload as { description: string }).description.includes("ATM"))!;
    const draws = await s.acct(s.vessel.id, "3100");
    const meals = await s.acct(s.vessel.id, "6900");
    expect((p.payload as { accountId: string }).accountId).toBe(draws);
    // Another client's account is refused (and nothing is approved).
    await expect(approveCoethaProposal(s.tabitha, s.vessel.id, p.id, { accountId: await s.acct(s.harbor.id, "6900") })).rejects.toThrow(/this client's active accounts/);
    expect((await prisma.coethaProposal.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PROPOSED");
    await approveCoethaProposal(s.tabitha, s.vessel.id, p.id, { accountId: meals });
    const e = await prisma.journalEntry.findFirstOrThrow({ where: { clientId: s.vessel.id }, include: { lines: true } });
    expect(e.lines.find((l) => l.debitCents === 30000)!.accountId).toBe(meals);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "coetha.proposal_approved" } })).details).toMatchObject({ edited: true, approvedAccountId: meals, recommendedAccountId: draws });
  });

  it("rejecting posts nothing; a rejected draft can't be approved later", async () => {
    const s = await setup();
    await runCoetha(s.daria, s.vessel.id, opts);
    const props = await open(s.vessel.id);
    const results = await decideCoethaProposals(s.tabitha, s.vessel.id, "REJECT", props.map((p) => ({ id: p.id })), "Not right for this client");
    expect(results.every((r) => r.result === "REJECTED")).toBe(true);
    expect(await prisma.journalEntry.count()).toBe(0);
    expect(await prisma.bankTransaction.count({ where: { clientId: s.vessel.id, status: "UNREVIEWED" } })).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: "coetha.proposal_rejected", actorId: s.tabitha.id } })).toBe(6);
    await expect(approveCoethaProposal(s.tabitha, s.vessel.id, props[0].id)).rejects.toThrow(/already rejected/);
    expect(await prisma.journalEntry.count()).toBe(0);
  });

  it("an adjusting entry posts once through the ledger as an adjustment; discrepancies and summaries never post", async () => {
    const s = await setup();
    await runCoetha(s.daria, s.vessel.id, opts);
    const [adj] = await open(s.vessel.id, "ADJUSTING_ENTRY");
    const r = await approveCoethaProposal(s.tabitha, s.vessel.id, adj.id);
    expect((await approveCoethaProposal(s.tabitha, s.vessel.id, adj.id)).result).toBe("ALREADY_APPROVED");
    const e = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.journalEntryId! }, include: { lines: true } });
    expect(e).toMatchObject({ source: "ADJUSTMENT", sourceKey: `coetha:${adj.id}`, createdById: s.tabitha.id });
    expect(e.lines.map((l) => [l.debitCents, l.creditCents]).sort()).toEqual([[0, 10000], [10000, 0]]);
    const others = [...(await open(s.vessel.id, "DISCREPANCY")), ...(await open(s.vessel.id, "MONTH_SUMMARY"))];
    for (const o of others) expect((await approveCoethaProposal(s.tabitha, s.vessel.id, o.id)).journalEntryId).toBeNull();
    expect(await prisma.journalEntry.count()).toBe(1);
  });

  it("staff keep doing manual bookkeeping; a row they post retires Coetha's draft for it (no double post)", async () => {
    const s = await setup();
    await runCoetha(s.daria, s.vessel.id, opts);
    const p = (await open(s.vessel.id, "CATEGORY"))[0];
    await categorizeBankTransaction(s.daria, s.vessel.id, p.bankTransactionId!, { accountId: await s.acct(s.vessel.id, "7900") });
    await expect(approveCoethaProposal(s.tabitha, s.vessel.id, p.id)).rejects.toThrow(/already posted or excluded by staff/);
    expect((await prisma.coethaProposal.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("SUPERSEDED");
    expect(await prisma.journalEntry.count()).toBe(1);
    // Bulk approval of the rest: each on its own.
    const rest = (await open(s.vessel.id, "CATEGORY")).map((x) => ({ id: x.id }));
    const results = await decideCoethaProposals(s.tabitha, s.vessel.id, "APPROVE", [...rest, { id: p.id }]);
    expect(results.map((x) => x.result)).toEqual(["APPROVED", "APPROVED", "SKIPPED"]);
    expect(await prisma.journalEntry.count()).toBe(3);
  });
});

describe("drafts prepared from completed financial statements", () => {
  it("Run Coetha never sends or replaces them; it only works on the other waiting rows", async () => {
    const s = await setup();
    const office = (await prisma.bankTransaction.findFirstOrThrow({ where: { clientId: s.vessel.id, description: { contains: "OFFICE" } } }));
    const run = await prisma.coethaRun.create({ data: { clientId: s.vessel.id, trigger: "RECORDS", model: "records", status: "OK", transactions: 1 } });
    const acct = await s.acct(s.vessel.id, "6300");
    const fromStatements = await prisma.coethaProposal.create({ data: { clientId: s.vessel.id, runId: run.id, kind: "CATEGORY", bankTransactionId: office.id, confidence: 0.99, reason: "“Office Supplies” — matches your completed statements to the cent.", model: "records", inputHash: "ref", payload: { bankTransactionId: office.id, date: "2026-10-02", amountCents: -8420, description: office.description, bankAccountName: "Checking", accountId: acct, accountCode: "6300", accountName: "Office Supplies", fromRecords: true, needsJudgment: false } } });
    await runCoetha(s.daria, s.vessel.id, opts);
    // Still open, untouched.
    expect((await prisma.coethaProposal.findUniqueOrThrow({ where: { id: fromStatements.id } })).status).toBe("PROPOSED");
    // Not sent to the model, and no AI draft was made for it.
    expect(sent.join("\n")).not.toContain("OFFICE DEPOT");
    expect(await prisma.coethaProposal.count({ where: { bankTransactionId: office.id, status: "PROPOSED" } })).toBe(1);
    // The other waiting rows were still worked on.
    expect((await open(s.vessel.id, "CATEGORY")).filter((p) => p.model !== "records")).toHaveLength(2);
    // A second run doesn't replace it either; nothing was posted.
    await runCoetha(s.daria, s.vessel.id, opts);
    expect((await prisma.coethaProposal.findUniqueOrThrow({ where: { id: fromStatements.id } })).status).toBe("PROPOSED");
    expect(await prisma.journalEntry.count({ where: { clientId: s.vessel.id } })).toBe(0);
  });
});
