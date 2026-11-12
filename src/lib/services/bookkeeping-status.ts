import "server-only";
import { prisma } from "@/lib/prisma";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { isPrimaryOwner } from "@/lib/auth/permissions";
import { todayCentral } from "./ledger";
import { registryLabel } from "./bank-accounts";
import { accountSynced } from "./monthly-workflow";
import { DECISIONS_MODEL } from "./coetha-decisions";

/**
 * Bookkeeping Clients Status (Owner's Office → Office Files): where every bookkeeping client
 * stands, read live from the records already kept — the months marked complete, approved and
 * released statements, Coetha's reference statements, bank feeds and imported or uploaded
 * statements, payroll reports and pay runs, reconciliations, Coetha's prepared and posted work and
 * her document reading. Nothing is stored or maintained by hand; the owner only.
 *
 * Missing documents run from the month after the last completed month through the last month that
 * has ended; anything already in Client Connect (a working feed, an imported statement, a statement
 * uploaded but not yet entered, payroll already in the books) is never listed as missing.
 */

const pad = (n: number) => String(n).padStart(2, "0");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ym = (y: number, m: number) => `${y}-${pad(m)}`;
const label = (k: string) => `${MON[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
const nextMonth = (k: string) => { const [y, m] = k.split("-").map(Number); return m === 12 ? ym(y + 1, 1) : ym(y, m + 1); };
const BANK = ["CHECKING", "SAVINGS"];
const CARD = ["CREDIT_CARD", "LINE_OF_CREDIT", "LOAN"];

export const OVERALL = ["Current", "In Progress", "Missing Documents", "Needs Attention", "Overdue"] as const;
export type Overall = (typeof OVERALL)[number];

export type UploadItem = { kind: "STATEMENTS_PDF" | "BANK" | "CARD" | "PAYROLL"; what: string; months: string[] };
export type ClientStatus = {
  clientId: string;
  name: string;
  assignedTo: string | null;
  schedule: string;
  payroll: string | null;
  completedThrough: string | null;
  completedHow: string | null;
  workingOn: string | null;
  onFile: string[];
  uploads: UploadItem[];
  uploadedNotEntered: number;
  discrepancies: { account: string; month: string; detail: string }[];
  coetha: string;
  corrections: { posted: number; waiting: number };
  ready: string[];
  overall: Overall;
  why: string;
};

function monthsBetween(from: string, to: string) {
  const out: string[] = [];
  for (let k = from; k <= to; k = nextMonth(k)) out.push(k);
  return out;
}
const range = (ks: string[]) => (!ks.length ? null : ks.length === 1 ? label(ks[0]) : `${label(ks[0])} – ${label(ks[ks.length - 1])}`);

export async function bookkeepingStatus(actor: Actor, today = todayCentral()): Promise<{ through: string; clients: ClientStatus[] }> {
  if (!(await isPrimaryOwner(actor.id))) throw new ForbiddenError("Bookkeeping Clients Status is in the owner's private office.");
  const [ty, tm, td] = today.split("-").map(Number);
  const last = tm === 1 ? ym(ty - 1, 12) : ym(ty, tm - 1); // the last month that has ended
  const current = ym(ty, tm);
  const year = Number(last.slice(0, 4));
  const yearStart = ym(year, 1);
  const profiles = await prisma.bookkeepingProfile.findMany({
    where: { active: true, client: { archivedAt: null } },
    select: { clientId: true, frequency: true, payroll: true, payrollProvider: true, reportsDueDay: true, client: { select: { displayName: true, businessName: true, assignedTo: { select: { name: true } } } } },
  });
  const out: ClientStatus[] = [];
  for (const p of profiles) {
    const clientId = p.clientId;
    const [complete, statements, reference, accounts, recons, proposals, reading, lastAnswer] = await Promise.all([
      prisma.bookkeepingPeriod.findMany({ where: { clientId, status: "COMPLETE", year: { gte: year } }, select: { year: true, month: true } }),
      prisma.document.findMany({ where: { clientId, deletedAt: null, supersededAt: null, reportType: { in: ["FINANCIAL_PACKET", "PROFIT_AND_LOSS", "BALANCE_SHEET"] }, year: { gte: year } }, select: { year: true, month: true, reportType: true, reviewStatus: true, visibility: true } }),
      prisma.coethaReference.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" }, select: { months: true } }),
      prisma.bookkeepingAccount.findMany({ where: { clientId, active: true, parentAccountId: null, monitored: true }, select: { id: true, ledgerAccountId: true, accountType: true, institution: true, nickname: true, last4: true } }),
      prisma.accountReconciliation.findMany({ where: { clientId, year, status: "EXCEPTION" }, select: { year: true, month: true, differenceCents: true, exceptions: true, bookkeepingAccount: { select: { institution: true, nickname: true, accountType: true, last4: true } } }, orderBy: [{ month: "asc" }] }),
      prisma.coethaProposal.groupBy({ by: ["status"], where: { clientId, model: DECISIONS_MODEL, kind: { in: ["ADJUSTING_ENTRY", "CATEGORY"] } }, _count: true }),
      prisma.coethaDocJob.count({ where: { clientId, status: { in: ["QUEUED", "READING", "WAITING"] } } }),
      prisma.coethaChatMessage.findFirst({ where: { clientId, role: "assistant" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    ]);

    // What's already done and on file.
    const refMonths = Array.isArray(reference?.months) ? (reference!.months as unknown[]).filter((x): x is string => typeof x === "string").sort() : [];
    const marked = complete.map((c) => ym(c.year, c.month)).sort();
    const finalized = statements.filter((d) => d.year && d.month && (d.visibility === "PUBLISHED" || d.reviewStatus === "APPROVED")).map((d) => ym(d.year!, d.month!)).sort();
    const candidates: [string, string][] = [
      ...(marked.length ? [[marked[marked.length - 1], "marked complete"] as [string, string]] : []),
      ...(finalized.length ? [[finalized[finalized.length - 1], "statements approved"] as [string, string]] : []),
      ...(refMonths.length ? [[refMonths[refMonths.length - 1], "completed statements on file"] as [string, string]] : []),
    ].sort((a, b) => a[0].localeCompare(b[0]));
    const done = candidates.length ? candidates[candidates.length - 1] : null;
    const onFile: string[] = [];
    if (refMonths.length) onFile.push(`Completed statements ${range(refMonths)}`);
    if (finalized.length) onFile.push(`Approved in Client Connect: ${[...new Set(finalized)].map(label).join(", ")}`);

    // Months still to do: after the last completed month, through the last month that ended.
    const todo = monthsBetween(done ? nextMonth(done[0]) : yearStart, last);
    const workingOn = range(monthsBetween(done ? nextMonth(done[0]) : yearStart, current));

    // Genuinely missing documents.
    const uploads: UploadItem[] = [];
    if (marked.length && !refMonths.length) uploads.push({ kind: "STATEMENTS_PDF", what: "Completed P&L and Balance Sheet PDF (Claude Projects) → Coetha page, Completed financial statements", months: [range([marked[0] < yearStart ? yearStart : marked[0], marked[marked.length - 1]])!] });
    let uploadedNotEntered = 0;
    for (const a of accounts) {
      const kind = BANK.includes(a.accountType) ? "BANK" : CARD.includes(a.accountType) ? "CARD" : null;
      if (!kind) continue;
      const missing: string[] = [];
      for (const k of todo) {
        const [y, m] = k.split("-").map(Number);
        if ((await accountSynced(clientId, a, y, m, today)).state !== "MISSING") continue;
        if (await prisma.document.count({ where: { clientId, deletedAt: null, bookkeepingAccountId: a.id, docType: { in: ["BANK_STATEMENT", "CARD_STATEMENT"] }, year: y, month: m } })) { uploadedNotEntered++; continue; }
        missing.push(label(k));
      }
      if (missing.length) uploads.push({ kind, what: `${registryLabel(a)} statements`, months: missing });
    }
    if (p.payroll) {
      const missing: string[] = [];
      for (const k of todo) {
        const [y, m] = k.split("-").map(Number);
        const from = new Date(`${k}-01T00:00:00Z`), to = new Date(Date.UTC(y, m, 0));
        const [docs, runs, posted] = await Promise.all([
          prisma.document.count({ where: { clientId, deletedAt: null, docType: "PAYROLL_REPORT", OR: [{ year: y, month: m }, { periodStart: { lte: to }, periodEnd: { gte: from } }] } }),
          prisma.payrollRun.count({ where: { clientId, checkDate: { gte: from, lte: to }, status: { notIn: ["VOID", "VOIDED", "DELETED"] } } }),
          prisma.journalLine.count({ where: { entry: { clientId, date: { gte: from, lte: to } }, account: { type: "EXPENSE", OR: [{ name: { contains: "payroll", mode: "insensitive" } }, { name: { contains: "wages", mode: "insensitive" } }] } } }),
        ]);
        if (!docs && !runs && !posted) missing.push(label(k));
      }
      if (missing.length) uploads.push({ kind: "PAYROLL", what: `${p.payrollProvider || "Payroll"} payroll register and tax reports`, months: missing });
    }

    // Reconciliation discrepancies, Coetha's work, corrections, statements ready.
    const discrepancies = recons.map((r) => ({ account: registryLabel(r.bookkeepingAccount), month: label(ym(r.year, r.month)), detail: r.exceptions[0] ?? (r.differenceCents ? `off by $${(Math.abs(r.differenceCents) / 100).toFixed(2)}` : "exception") }));
    const count = (s: string) => proposals.find((x) => x.status === s)?._count ?? 0;
    const corrections = { posted: count("APPROVED"), waiting: count("PROPOSED") };
    const coetha = [reading ? `reading ${reading} document${reading === 1 ? "" : "s"}` : null, corrections.waiting ? `${corrections.waiting} item${corrections.waiting === 1 ? "" : "s"} waiting for you` : null, lastAnswer ? `last worked ${lastAnswer.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" })}` : "not started"].filter(Boolean).join(" · ");
    const unreleased = statements.filter((d) => d.year && d.month && d.visibility !== "PUBLISHED");
    const ready = [...new Set(unreleased.map((d) => ym(d.year!, d.month!)))].sort().map((k) => {
      const docs = unreleased.filter((d) => ym(d.year!, d.month!) === k);
      return `${label(k)}: ${docs.every((d) => d.reviewStatus === "APPROVED") ? "approved, ready to release" : "ready for your review"}`;
    });

    // Overall status.
    const behind = todo.length;
    const dueDay = p.reportsDueDay ?? 15;
    let overall: Overall, why: string;
    if (discrepancies.length || corrections.waiting) { overall = "Needs Attention"; why = [discrepancies.length ? `${discrepancies.length} reconciliation discrepanc${discrepancies.length === 1 ? "y" : "ies"}` : "", corrections.waiting ? `${corrections.waiting} item${corrections.waiting === 1 ? "" : "s"} waiting for you` : ""].filter(Boolean).join(" · "); }
    else if (uploads.length) { overall = "Missing Documents"; why = `${uploads.reduce((n, u) => n + u.months.length, 0)} item${uploads.reduce((n, u) => n + u.months.length, 0) === 1 ? "" : "s"} to upload`; }
    else if (behind > 1 || (behind === 1 && td > dueDay)) { overall = "Overdue"; why = `${range(todo)} not completed${behind === 1 ? ` (due the ${dueDay}${dueDay === 1 ? "st" : dueDay === 2 ? "nd" : dueDay === 3 ? "rd" : "th"})` : ""}`; }
    else if (behind === 1) { overall = "In Progress"; why = `${label(todo[0])} in progress`; }
    else { overall = "Current"; why = `Completed through ${label(last)}`; }

    out.push({
      clientId,
      name: p.client.businessName || p.client.displayName,
      assignedTo: p.client.assignedTo?.name ?? null,
      schedule: p.frequency === "QUARTERLY" ? "Quarterly" : "Monthly",
      payroll: p.payroll ? p.payrollProvider || "Payroll" : null,
      completedThrough: done ? label(done[0]) : null,
      completedHow: done ? done[1] : null,
      workingOn,
      onFile,
      uploads,
      uploadedNotEntered,
      discrepancies,
      coetha,
      corrections,
      ready,
      overall,
      why,
    });
  }
  const rank: Record<Overall, number> = { "Needs Attention": 0, Overdue: 1, "Missing Documents": 2, "In Progress": 3, Current: 4 };
  out.sort((a, b) => rank[a.overall] - rank[b.overall] || a.name.localeCompare(b.name));
  return { through: label(last), clients: out };
}
