import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { deliverAcceptedReturn } from "@/lib/services/accepted-returns";
import { form8879Status } from "@/lib/services/auto-tax-summary";
import { HISTORICAL_FILING_NOTE } from "@/lib/services/tax-summary";

// Form 8879 and summary approval apply from tax year 2026 on. Fictional taxpayers and returns only.
async function f1040(year: number, form = "1040") {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([612, 792]);
  const lines = form === "1040-X"
    ? ["Form 1040-X Amended U.S. Individual Income Tax Return", `This return is for calendar year ${year}`, "Your first name and middle initial    Last name", "Rosalind    Pembrook"]
    : [`Form 1040 ${year} U.S. Individual Income Tax Return`, `For the year Jan. 1-Dec. 31, ${year}`, "Your first name and middle initial    Last name", "Rosalind    Pembrook"];
  let y = 760;
  for (const l of lines) { p.drawText(l, { x: 40, y, size: 10, font: f }); y -= 14; }
  return { bytes: await d.save(), originalName: `${year}-${form}.pdf` };
}

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ clean: true }), { status: 200 })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const client = await createClient(tabitha, { firstName: "Rosalind", lastName: "Pembrook", clientType: "INDIVIDUAL", status: "ACTIVE" });
  return { tabitha, client };
}
const deliver = async (s: Awaited<ReturnType<typeof setup>>, taxYear: number, filingType: "ORIGINAL" | "AMENDED", owner: { form8879Confirmed: boolean; filingNow?: boolean }) =>
  deliverAcceptedReturn(s.tabitha, { clientId: s.client.id, taxYear, filingType, filings: [{ jurisdiction: "FEDERAL", returnType: filingType === "AMENDED" ? "1040-X" : "1040", acceptedOn: "2026-03-01" }], combinedReturn: await f1040(taxYear, filingType === "AMENDED" ? "1040-X" : "1040"), verificationNote: "IRS acknowledgment checked", owner });

describe("Form 8879 by tax year", () => {
  it("2022–2025 returns already filed: recorded without a new 8879 or summary approval, and nothing is requested", async () => {
    const s = await setup();
    for (const year of [2022, 2023, 2024, 2025]) {
      const r = await deliver(s, year, "ORIGINAL", { form8879Confirmed: false });
      expect(r.results[0].outcome).toBe("accepted");
    }
    const notes = await prisma.filingStatusEvent.findMany({ where: { toValue: "SUBMITTED" }, select: { verificationNote: true } });
    expect(notes.every((n) => n.verificationNote?.includes(HISTORICAL_FILING_NOTE))).toBe(true);
    // No summary approval was created or sent to the client for those years.
    expect(await prisma.taxReturnSummary.count()).toBe(0);
  });

  it("a 2025 return being filed late now, a 2026 return, and any amended return follow the e-file authorization rules", async () => {
    const s = await setup();
    await expect(deliver(s, 2025, "ORIGINAL", { form8879Confirmed: false, filingNow: true })).rejects.toThrow(/Form 8879/);
    await expect(deliver(s, 2026, "ORIGINAL", { form8879Confirmed: false })).rejects.toThrow(/Form 8879/);
    await expect(deliver(s, 2024, "AMENDED", { form8879Confirmed: false })).rejects.toThrow(/Form 8879/);
    expect(await prisma.filingRecord.count({ where: { filingStatus: "ACCEPTED" } })).toBe(0);
  });

  it("the 8879 tracker never shows 'waiting to send' for an approved 2022–2025 summary; 2026 does", () => {
    const base = { id: "s1", status: "CLIENT_APPROVED", figuresHash: "h", returnTotals: {} };
    expect(form8879Status({ ...base, taxYear: 2025, filingType: "ORIGINAL" }).status).toBe("NONE");
    expect(form8879Status({ ...base, taxYear: 2026, filingType: "ORIGINAL" }).status).toBe("WAITING");
    expect(form8879Status({ ...base, taxYear: 2024, filingType: "AMENDED" }).status).toBe("WAITING");
  });
});
