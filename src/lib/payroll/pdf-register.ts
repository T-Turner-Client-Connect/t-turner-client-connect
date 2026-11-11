import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { storage } from "@/lib/storage";
import { decryptBytes, encryptBytes } from "@/lib/crypto";
import { callPayrollReader, CoethaModelError, coethaKeyPresent, type PayrollRegisterOutputT } from "@/lib/coetha-model";
import type { Mapping } from "./register";
import type { PayrollField } from "./fields";

/**
 * ADP RUN (and other providers) export the payroll register as a PDF. Coetha reads its figures
 * into the same rows the CSV/Excel importer reads, so everything after this (preview, pay dates
 * that must tie out, draft pay runs, dedupe, journal entries for approval) is the existing
 * importer, unchanged.
 *
 * - Only for a business Coetha may work on (Coetha on, API key present, client hasn't opted out).
 * - What is sent: the PDF's text lines with SSNs, EINs and long numbers removed.
 * - Nothing is trusted: each pay date's employee lines must add up to the register's own printed
 *   totals, and each employee must tie out (gross − taxes − deductions = net) in the existing
 *   checks; otherwise the file is refused, not "fixed".
 * - The figures read from a file are kept (encrypted, by the file's fingerprint), so the preview
 *   and the import use exactly the same numbers and the file isn't read twice.
 */

export class PayrollPdfError extends Error {}

const COLUMNS: [PayrollField, string][] = [
  ["checkDate", "Check date"], ["periodStart", "Period start"], ["periodEnd", "Period end"], ["employee", "Employee"], ["hours", "Hours"],
  ["gross", "Gross pay"], ["federalWh", "Federal income tax"], ["ssEe", "Social Security (employee)"], ["medicareEe", "Medicare (employee)"],
  ["stateWh", "State income tax"], ["otherEeTax", "Other employee taxes"], ["employerTax", "Employer taxes"], ["deductions", "Deductions"], ["netPay", "Net pay"],
];
export const PDF_MAPPING: Mapping = Object.fromEntries(COLUMNS.map(([f], i) => [i, f]));

const pdfMagic = (bytes: Uint8Array) => bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
export const isPdfFile = (bytes: Uint8Array, fileName: string) => /\.pdf$/i.test(fileName) || pdfMagic(bytes);
const ymd = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "");
const c = (n: number) => Math.round(n * 100);
const d = (cents: number) => (cents / 100).toFixed(2);

/** De-identified text: SSN/EIN shapes and long digit runs removed, line by line. */
export function payrollText(lines: string[]) {
  return lines
    .map((l) => l.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]").replace(/\b\d{2}-\d{7}\b/g, "[ein]").replace(/\b(?:x+|\*+)?\d{6,}\b/gi, "[number]").trim().slice(0, 400))
    .filter(Boolean)
    .slice(0, 3000);
}

/** Checks Coetha's reading against the register's own totals and turns it into importer rows. */
export function gridFromReading(out: PayrollRegisterOutputT): string[][] {
  if (!out.payDates.length) throw new PayrollPdfError("No pay dates were found in this PDF. Make sure it is the payroll register (not a summary or a check stub).");
  const rows: string[][] = [COLUMNS.map(([, label]) => label)];
  for (const p of out.payDates) {
    if (!ymd(p.checkDate)) throw new PayrollPdfError("A check date in this PDF couldn't be read. Export the register again, or use Excel.");
    if (!p.employees.length) throw new PayrollPdfError(`No employees were found for the ${p.checkDate} check date.`);
    const gross = p.employees.reduce((n, e) => n + c(e.gross), 0);
    const net = p.employees.reduce((n, e) => n + c(e.netPay), 0);
    if (p.printedTotals.gross != null && c(p.printedTotals.gross) !== gross) throw new PayrollPdfError(`For ${p.checkDate}, the employees' gross pay adds up to $${d(gross)} but the register's total is $${d(c(p.printedTotals.gross))}. Nothing was imported; export the register as Excel instead.`);
    if (p.printedTotals.netPay != null && c(p.printedTotals.netPay) !== net) throw new PayrollPdfError(`For ${p.checkDate}, the employees' net pay adds up to $${d(net)} but the register's total is $${d(c(p.printedTotals.netPay))}. Nothing was imported; export the register as Excel instead.`);
    // Employer taxes are given per pay date; they go on the first employee's line so the pay date's total is right.
    p.employees.forEach((e, i) => {
      rows.push([p.checkDate, ymd(p.periodStart), ymd(p.periodEnd), e.name.slice(0, 120), String(e.hours), d(c(e.gross)), d(c(e.federalWh)), d(c(e.socialSecurity)), d(c(e.medicare)), d(c(e.stateWh)), d(c(e.otherEmployeeTaxes)), i === 0 ? d(c(p.employerTaxes)) : "0.00", d(c(e.deductions)), d(c(e.netPay))]);
    });
  }
  return rows;
}

/** Whole pages per part, about this many text lines each (a part is one quick reading). */
const CHUNK_LINES = 70;
const MAX_CHUNKS = 12;

/** Groups whole pages into parts of about CHUNK_LINES lines (a page is never split). */
export function pageChunks(pages: string[][]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const p of pages) {
    if (!p.length) continue;
    if (cur.length && cur.length + p.length > CHUNK_LINES) { out.push(cur); cur = []; }
    cur = cur.concat(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Joins the readings of several parts of one register by check date: employees are listed once
 * from the part they appear in; a pay date's printed totals and employer taxes come from the part
 * that printed its totals line (parts that print different totals for the same date are refused).
 */
export function mergeReadings(parts: PayrollRegisterOutputT[]): PayrollRegisterOutputT {
  const byDate = new Map<string, PayrollRegisterOutputT["payDates"][number] & { _taxesFromTotals: boolean }>();
  for (const part of parts) {
    for (const p of part.payDates) {
      const hasTotals = p.printedTotals.gross != null || p.printedTotals.netPay != null;
      const cur = byDate.get(p.checkDate);
      if (!cur) {
        byDate.set(p.checkDate, { ...p, employees: [...p.employees], _taxesFromTotals: hasTotals });
        continue;
      }
      cur.employees.push(...p.employees);
      cur.periodStart ??= p.periodStart;
      cur.periodEnd ??= p.periodEnd;
      for (const k of ["gross", "netPay"] as const) {
        const v = p.printedTotals[k];
        if (v == null) continue;
        if (cur.printedTotals[k] != null && Math.round(cur.printedTotals[k]! * 100) !== Math.round(v * 100)) throw new PayrollPdfError(`The register shows two different totals for ${p.checkDate}. Nothing was imported; export the register as Excel instead.`);
        cur.printedTotals[k] = v;
      }
      // Employer taxes: the totals part wins; otherwise the parts' amounts add up.
      if (hasTotals && !cur._taxesFromTotals) { cur.employerTaxes = p.employerTaxes; cur._taxesFromTotals = true; }
      else if (!hasTotals && !cur._taxesFromTotals) cur.employerTaxes += p.employerTaxes;
    }
  }
  return { payDates: [...byDate.values()].map(({ _taxesFromTotals: _t, ...p }) => p).sort((a, b) => a.checkDate.localeCompare(b.checkDate)) };
}

const cacheKey = (clientId: string, sha: string) => `client_document/payroll_pdf/${clientId}/${sha}`;

/** The importer rows for a payroll register PDF (read once per file, then reused). */
export async function readPayrollPdf(actor: Actor, clientId: string, bytes: Uint8Array): Promise<string[][]> {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const key = cacheKey(clientId, sha);
  const cached = await storage.get(key).catch(() => null);
  if (cached) return JSON.parse(new TextDecoder().decode(decryptBytes(cached))) as string[][];

  const { coethaOn } = await import("@/lib/services/owner-switches");
  const { coethaOptOutView } = await import("@/lib/services/coetha-opt-out");
  if (!(await coethaOn()) || !coethaKeyPresent()) throw new PayrollPdfError("Reading a PDF register needs Coetha turned on. Export the register as Excel (.xlsx) or CSV instead.");
  if (await coethaOptOutView(clientId)) throw new PayrollPdfError("This client prefers no Coetha, so a PDF register can't be read. Export it as Excel (.xlsx) or CSV instead.");
  const { pdfPageLines } = await import("@/lib/statement-pdf");
  const pages = await pdfPageLines(bytes);
  if (!pages?.some((p) => p.length)) throw new PayrollPdfError("No text could be read from this PDF (it may be a scan). Export the register from ADP as PDF or Excel again.");
  const chunks = pageChunks(pages.map((p) => payrollText(p)));
  if (chunks.length > MAX_CHUNKS) throw new PayrollPdfError(`This register is too long to read in one go (${pages.length} pages). Export fewer pay dates at a time, or export it as Excel (.xlsx).`);
  let res;
  try {
    // A page request has about 30 seconds: the pages are read in parts at the same time, so even a
    // long register finishes in time. The parts are joined by check date and then held to the
    // register's own printed totals, exactly as before.
    const parts = await Promise.all(chunks.map((c) => callPayrollReader(c)));
    res = { output: mergeReadings(parts.map((p) => p.output)), model: parts[0].model, inputTokens: parts.reduce((n, p) => n + p.inputTokens, 0), outputTokens: parts.reduce((n, p) => n + p.outputTokens, 0) };
  } catch (err) {
    if (err instanceof CoethaModelError) throw new PayrollPdfError(`Coetha couldn't read this PDF: ${err.message} Export the register as Excel (.xlsx) instead, or try again.`);
    throw err;
  }
  const grid = gridFromReading(res.output);
  await storage.put(key, encryptBytes(new TextEncoder().encode(JSON.stringify(grid))));
  await audit(prisma, { actorId: actor.id, action: "payroll.pdf_read", entityType: "Client", entityId: clientId, clientId, details: { sha256: sha, payDates: res.output.payDates.length, model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens } });
  return grid;
}
