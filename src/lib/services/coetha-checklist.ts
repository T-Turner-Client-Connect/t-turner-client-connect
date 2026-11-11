import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { canSendClientRequests } from "./bk-permissions";
import { toDate, ymdOf } from "./ledger";
import { monthlyChecklist } from "./monthly-workflow";

/**
 * The Monthly Progress checklist, for Coetha in Ask Coetha.
 *
 * Every line on the card is worked out from the records, so most lines clear themselves the moment
 * the work is entered (a statement imported, rows categorized, an account reconciled). Coetha can
 * read the checklist for any month, and clear the lines that depend on paperwork:
 * - a receipt / supporting-document request answered by a file already on file (Received),
 * - a request that turned out not to be needed (closed, with the reason),
 * - a payroll report uploaded in Ask Coetha, filed as that month's payroll report.
 * Tabitha's approval and the release to the client are never cleared by Coetha.
 */

const pad = (n: number) => String(n).padStart(2, "0");
const monthOk = (s: unknown): s is string => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const monthBounds = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return { y, m, from: toDate(`${ym}-01`), to: toDate(`${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`) };
};
const RECEIPT_KINDS = ["SUPPORTING", "MONTHLY", "GENERAL"];

/** How each line clears, in the words Coetha uses with staff. */
const HOW_IT_CLEARS: Record<string, string> = {
  BANK_SYNC: "Clears by itself when every bank account has a feed synced past month end or a statement imported for the month.",
  CARD_SYNC: "Clears by itself when every card account has a feed synced past month end or a statement imported for the month.",
  RECEIPTS: "Clears when each outstanding request is answered (update_checklist request_received with the file) or closed as not needed, and nothing is left in Ask My Accountant for the month.",
  PAYROLL: "Clears when a payroll report for the month is on file (an ADP register import, or update_checklist payroll_received for a file uploaded here).",
  CATEGORIZED: "Clears by itself when no bank or card row for the month is still waiting.",
  RECONCILED: "Clears by itself when every account's reconciliation for the month is balanced and approved by Tabitha.",
  PREPARED: "Clears by itself when the month's P&L / Balance Sheet is saved.",
  APPROVAL: "Only Tabitha clears this, by approving the statements. Coetha never does.",
  RELEASED: "Only Tabitha clears this, by releasing the statements to the client. Coetha never does.",
};

/** The checklist for one month, with the open requests and the unfiled uploads Coetha can use to clear lines. Read-only. */
export async function checklistForCoetha(clientId: string, ym: string, opts: { today?: string } = {}) {
  const { y, m, from, to } = monthBounds(ym);
  const c = await monthlyChecklist(clientId, y, m, opts);
  const period = await prisma.bookkeepingPeriod.findUnique({ where: { clientId_year_month: { clientId, year: y, month: m } }, select: { id: true } });
  const [requests, uploads] = await Promise.all([
    prisma.documentRequest.findMany({
      where: { clientId, kind: { in: RECEIPT_KINDS }, status: { in: ["DRAFT", "OPEN"] }, OR: [{ periodId: period?.id ?? "-" }, { periodStart: { gte: from, lte: to } }] },
      orderBy: { createdAt: "asc" }, take: 50,
      select: { id: true, title: true, reason: true, status: true, periodStart: true, periodEnd: true, source: true },
    }),
    // Files saved for this business that aren't filed as anything yet (for example uploaded in Ask Coetha).
    prisma.document.findMany({
      where: { clientId, deletedAt: null, category: "BOOKKEEPING", reportType: null, requestId: null, OR: [{ docType: null }, { docType: "BK_OTHER" }] },
      orderBy: { createdAt: "desc" }, take: 25, select: { id: true, title: true, createdAt: true },
    }),
  ]);
  return {
    month: ym, percentComplete: c.percent, done: c.done, total: c.total,
    lines: c.items.map((i) => ({ key: i.key, line: i.label, status: i.state, shows: i.pill ?? null, detail: i.detail, howItClears: HOW_IT_CLEARS[i.key] ?? null })),
    outstandingRequests: requests.map((r) => ({ requestId: r.id, title: r.title, reason: r.reason, status: r.status === "DRAFT" ? "draft (not sent to the client)" : "sent, waiting on the client", period: r.periodStart ? `${ymdOf(r.periodStart)} to ${r.periodEnd ? ymdOf(r.periodEnd) : ymdOf(r.periodStart)}` : null, preparedBy: r.source })),
    unfiledUploads: uploads.map((d) => ({ documentId: d.id, name: d.title, uploaded: ymdOf(d.createdAt) })),
  };
}

export const CHECKLIST_TOOLS = [
  {
    name: "monthly_checklist",
    description: "Read this business's Monthly Progress checklist for one month (the same card staff see): each line's status and how it clears, the outstanding receipt / supporting-document requests (with requestId), and files uploaded here that aren't filed yet (with documentId). Read-only.",
    input_schema: { type: "object" as const, properties: { month: { type: "string", description: "YYYY-MM" } }, required: ["month"] },
  },
  {
    name: "update_checklist",
    description: "Clear a paperwork line on the Monthly Progress checklist once the work is in. request_received: the file (documentId) answers an outstanding request (requestId). request_not_needed: close a request that isn't needed any more (note says why). payroll_received: file an uploaded payroll report (documentId) as that month's payroll report. Never use it for approval or release; those are Tabitha's. Read monthly_checklist first for the ids.",
    input_schema: {
      type: "object" as const,
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["request_received", "request_not_needed", "payroll_received"] },
              requestId: { type: "string" },
              documentId: { type: "string" },
              month: { type: "string", description: "YYYY-MM (payroll_received)" },
              note: { type: "string", description: "One line: why (required for request_not_needed)" },
            },
            required: ["action"],
          },
        },
      },
      required: ["updates"],
    },
  },
];
export const CHECKLIST_TOOL_NAMES = new Set(CHECKLIST_TOOLS.map((t) => t.name));

type Update = { action?: unknown; requestId?: unknown; documentId?: unknown; month?: unknown; note?: unknown };
const str = (v: unknown, n = 200) => (typeof v === "string" ? v.trim().slice(0, n) : "");

/** One update for ONE business. Each refusal is returned in plain words; nothing outside this business is touched. */
async function applyUpdate(actor: Actor, clientId: string, u: Update): Promise<string> {
  const action = str(u.action, 40);
  const note = str(u.note, 300);
  if (action === "request_received" || action === "request_not_needed") {
    const req = await prisma.documentRequest.findFirst({ where: { id: str(u.requestId, 60), clientId, kind: { in: RECEIPT_KINDS }, status: { in: ["DRAFT", "OPEN"] } } });
    if (!req) return "No outstanding request with that id for this business (it may already be answered or closed).";
    if (action === "request_not_needed") {
      if (!note) return "Say in the note why the request isn't needed.";
      const r = await prisma.documentRequest.updateMany({ where: { id: req.id, clientId, status: { in: ["DRAFT", "OPEN"] } }, data: { status: "CANCELLED" } });
      if (!r.count) return "That request was just answered or closed.";
      await audit(prisma, { actorId: actor.id, action: "coetha.checklist_request_closed", entityType: "DocumentRequest", entityId: req.id, clientId, details: { title: req.title, wasSent: req.status === "OPEN", note } });
      return `Closed as not needed: ${req.title}`;
    }
    const doc = await prisma.document.findFirst({ where: { id: str(u.documentId, 60), clientId, deletedAt: null }, select: { id: true, requestId: true, category: true } });
    if (!doc) return "That file isn't on file for this business.";
    if (doc.category === "IDENTITY") return "Identity documents can't answer a bookkeeping request.";
    if (doc.requestId && doc.requestId !== req.id) return "That file already answers another request.";
    const r = await prisma.documentRequest.updateMany({ where: { id: req.id, clientId, status: { in: ["DRAFT", "OPEN"] } }, data: { status: "SUBMITTED" } });
    if (!r.count) return "That request was just answered or closed.";
    await prisma.document.update({ where: { id: doc.id }, data: { requestId: req.id, ...(req.bookkeepingAccountId ? { bookkeepingAccountId: req.bookkeepingAccountId } : {}) } });
    await audit(prisma, { actorId: actor.id, action: "coetha.checklist_request_received", entityType: "DocumentRequest", entityId: req.id, clientId, details: { title: req.title, documentId: doc.id, note: note || null } });
    return `Marked received: ${req.title}`;
  }
  if (action === "payroll_received") {
    if (!monthOk(u.month)) return "Give the payroll month as YYYY-MM.";
    return filePayrollReport(actor, clientId, str(u.documentId, 60), u.month, note || null);
  }
  return "Unknown update. Use request_received, request_not_needed or payroll_received.";
}

/**
 * Files a document already on file for this business (for example an ADP payroll register
 * uploaded in Ask Coetha) as the month's payroll report: the same record, labeled, dated to the
 * month and kept staff-only. The Monthly Progress "Payroll data received" line then shows it.
 */
export async function filePayrollReport(actor: Actor, clientId: string, documentId: string, ym: string, note: string | null = null): Promise<string> {
  if (!monthOk(ym)) return "Give the payroll month as YYYY-MM.";
  const profile = await prisma.bookkeepingProfile.findUnique({ where: { clientId }, select: { payroll: true } });
  if (!profile?.payroll) return "Payroll isn't turned on for this business, so there's no payroll line to clear.";
  const doc = await prisma.document.findFirst({ where: { id: documentId, clientId, deletedAt: null }, select: { id: true, docType: true, category: true, title: true } });
  if (!doc) return "That file isn't on file for this business.";
  if (doc.category === "IDENTITY") return "That file can't be filed as a payroll report.";
  if (doc.docType && doc.docType !== "BK_OTHER" && doc.docType !== "PAYROLL_REPORT") return "That file is already filed as something else.";
  const { y, m, from, to } = monthBounds(ym);
  // Payroll reports stay staff-only (they list employees' pay).
  await prisma.document.update({ where: { id: doc.id }, data: { category: "BOOKKEEPING", docType: "PAYROLL_REPORT", visibility: "STAFF_ONLY", year: y, month: m, periodStart: from, periodEnd: to, reportPeriodType: "MONTH" } });
  await audit(prisma, { actorId: actor.id, action: "coetha.checklist_payroll_received", entityType: "Document", entityId: doc.id, clientId, details: { month: ym, note } });
  return `Filed as the ${ym} payroll report: ${doc.title}`;
}

/** Runs one checklist tool call for ONE business. Clearing needs the same permission as handling the business's document requests. */
export async function runChecklistTool(actor: Actor, clientId: string, name: string, input: unknown) {
  const q = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (name === "monthly_checklist") {
    if (!monthOk(q.month)) return { error: "Give the month as YYYY-MM." };
    return checklistForCoetha(clientId, q.month);
  }
  if (name === "update_checklist") {
    if (!(await canSendClientRequests(actor, clientId))) return { error: "The person asking can't handle this business's document requests, so nothing was cleared. Tabitha, an Admin or the assigned bookkeeper can." };
    const updates = Array.isArray(q.updates) ? (q.updates as Update[]).slice(0, 25) : [];
    if (!updates.length) return { error: "No updates given." };
    const results = [];
    for (const u of updates) results.push({ action: str(u.action, 40), result: await applyUpdate(actor, clientId, u) });
    return { results };
  }
  return { error: `Unknown tool ${name}.` };
}
