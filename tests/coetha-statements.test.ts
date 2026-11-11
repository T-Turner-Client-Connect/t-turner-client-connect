import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { postJournalEntry, setupLedger } from "@/lib/services/ledger";
import { prepareStatementsFromBooks } from "@/lib/services/coetha-statements";
import { monthlyChecklist } from "@/lib/services/monthly-workflow";

// Fictional business and figures only.
beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});

describe("Coetha prepares the P&L and Balance Sheet from the books", () => {
  it("builds both from the ledger, saves them as drafts (a new version replaces the old), and the checklist shows them prepared", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const biz = await createClient(tabitha, { businessName: "Pretend Harbor Cafe LLC", clientType: "BUSINESS", status: "ACTIVE" });
    await managed(biz.id);
    await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false });
    await setupLedger(tabitha, biz.id, { basis: "CASH" });
    const acct = async (type: string) => (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: biz.id, type, ...(type === "ASSET" ? { subtype: "BANK" } : { OR: [{ subtype: null }, { subtype: { notIn: ["SUSPENSE", "COGS", "OTHER_INCOME", "OTHER_EXPENSE"] } }] }) } })).id;
    await postJournalEntry(tabitha, biz.id, { date: "2026-10-15", memo: "Fictional sales", lines: [{ accountId: await acct("ASSET"), debit: "1500.00" }, { accountId: await acct("INCOME"), credit: "1500.00" }] });
    await postJournalEntry(tabitha, biz.id, { date: "2026-10-20", memo: "Fictional supplies", lines: [{ accountId: await acct("EXPENSE"), debit: "400.00" }, { accountId: await acct("ASSET"), credit: "400.00" }] });

    const r = await prepareStatementsFromBooks(tabitha, biz.id, "2026-10");
    expect(r.figures).toMatchObject({ netIncome: "$1,100.00" });
    expect(r.saved).toEqual(["Profit & Loss v1 (draft, staff-only)", "Balance Sheet v1 (draft, staff-only)", "Financial Statements Package v1 (draft, staff-only)"]);
    if (process.env.PACKAGE_SAMPLE) { const { booksPackagePdf } = await import("@/lib/services/client-statements"); const { writeFileSync } = await import("node:fs"); writeFileSync(process.env.PACKAGE_SAMPLE, (await booksPackagePdf(biz.id, 2026, 10, { draft: true })).pdf); }
    const docs = await prisma.document.findMany({ where: { clientId: biz.id, reportType: { in: ["PROFIT_AND_LOSS", "BALANCE_SHEET"] }, supersededAt: null } });
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.visibility === "STAFF_ONLY")).toBe(true);
    expect((await monthlyChecklist(biz.id, 2026, 10, { today: "2026-11-11" })).items.find((i) => i.key === "PREPARED")?.state).toBe("DONE");

    // Same books: nothing new is saved. After an entry posts, a new version replaces the draft.
    const same = await prepareStatementsFromBooks(tabitha, biz.id, "2026-10");
    expect(same.saved.every((x) => x.includes("unchanged"))).toBe(true);
    await postJournalEntry(tabitha, biz.id, { date: "2026-10-25", memo: "Fictional more sales", lines: [{ accountId: await acct("ASSET"), debit: "100.00" }, { accountId: await acct("INCOME"), credit: "100.00" }] });
    const again = await prepareStatementsFromBooks(tabitha, biz.id, "2026-10");
    expect(again.saved).toEqual(["Profit & Loss v2 (draft, staff-only)", "Balance Sheet v2 (draft, staff-only)", "Financial Statements Package v2 (draft, staff-only)"]);
    expect(again.figures.netIncome).toBe("$1,200.00");
    expect(await prisma.document.count({ where: { clientId: biz.id, reportType: { in: ["PROFIT_AND_LOSS", "BALANCE_SHEET", "FINANCIAL_PACKET"] }, supersededAt: null } })).toBe(3);
  });
});
