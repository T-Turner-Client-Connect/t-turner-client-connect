import "server-only";
import { PDFDocument, rgb, StandardFonts, degrees, type PDFFont, type PDFPage } from "pdf-lib";
import { prisma } from "@/lib/prisma";
import { BUSINESS } from "@/lib/business";
import { LOGO_MARK_PNG_BASE64 } from "@/lib/brand-logo";
import { BASIS, longDate, reportPeriod, type PeriodType } from "@/lib/bookkeeping-periods";
import { readDocumentBytes, REPORT_LABELS } from "./documents";
import { accountLabel } from "./bookkeeping-profile";

/**
 * Printable financial packet for one client and reporting period, laid out
 * like the firm's statement packets (landscape letter): a cover page with the
 * period and basis, prepared-for / prepared-by details and contents, followed
 * by the statements staff prepared and uploaded — each client's own records,
 * page for page. Nothing in the statements is recalculated or rewritten.
 */

const ORDER = ["PROFIT_AND_LOSS", "GROSS_RECEIPTS", "BALANCE_SHEET", "BANK_RECONCILIATION", "SUPPORTING_SCHEDULE", "OTHER_REPORT"];
const NAVY = rgb(0.0, 0.08, 0.32);
const BLUE = rgb(0.17, 0.3, 0.55);
const GRAY = rgb(0.4, 0.42, 0.47);
const RULE = rgb(0.82, 0.83, 0.86);
export const PACKET_TAGLINE = "Bookkeeping & Accounting Services";

type Viewer = { staff: true } | { portalUserId: string };

/** Reports that make up a packet: the newest version of each; for clients, only delivered, scanned-clean ones. */
export async function packetReports(periodId: string, periodType: PeriodType, viewer: Viewer) {
  const docs = await prisma.document.findMany({
    where: {
      periodId,
      deletedAt: null,
      category: "BOOKKEEPING",
      reportType: { not: null },
      // Staff work on the newest version. Clients see what was delivered: an older
      // version stays published until its revision is delivered (then it's unpublished).
      ...("staff" in viewer ? { supersededAt: null } : {}),
      ...(periodType === "MONTH" ? { OR: [{ reportPeriodType: "MONTH" }, { reportPeriodType: null }] } : { reportPeriodType: periodType }),
      ...("staff" in viewer ? {} : { visibility: "PUBLISHED", scanStatus: "CLEAN" }),
    },
    include: { file: true, bookkeepingAccount: true },
    orderBy: { createdAt: "asc" },
  });
  return docs.sort((a, b) => ORDER.indexOf(a.reportType!) - ORDER.indexOf(b.reportType!));
}

/** The packets (month / quarter / year to date) available in a bookkeeping month. */
export async function packetsInPeriod(periodId: string, viewer: Viewer) {
  const docs = await prisma.document.findMany({
    where: { periodId, deletedAt: null, category: "BOOKKEEPING", reportType: { not: null }, ...("staff" in viewer ? { supersededAt: null } : { visibility: "PUBLISHED", scanStatus: "CLEAN" }) },
    select: { reportPeriodType: true },
  });
  return [...new Set(docs.map((d) => (d.reportPeriodType ?? "MONTH") as PeriodType))];
}

// pdf-lib's standard fonts use WinAnsi: keep common punctuation, replace anything else.
const safe = (t: string) => t.replace(/[^\x20-\x7E -ÿ–—•‘’“”…]/g, "?");

function footer(page: PDFPage, font: PDFFont, n: number, total: number) {
  const { width } = page.getSize();
  page.drawLine({ start: { x: 54, y: 44 }, end: { x: width - 54, y: 44 }, thickness: 0.5, color: RULE });
  page.drawText(safe(`${BUSINESS.displayName} • Confidential`), { x: 54, y: 30, size: 8, font, color: GRAY });
  const p = `Page ${n} of ${total}`;
  page.drawText(p, { x: width - 54 - font.widthOfTextAtSize(p, 8), y: 30, size: 8, font, color: GRAY });
}

function centered(page: PDFPage, text: string, y: number, font: PDFFont, size: number, color = NAVY) {
  const t = safe(text);
  page.drawText(t, { x: (page.getSize().width - font.widthOfTextAtSize(t, size)) / 2, y, size, font, color });
}

function wrap(text: string, font: PDFFont, size: number, max: number) {
  const out: string[] = [];
  let line = "";
  for (const w of safe(text).split(" ")) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > max && line) {
      out.push(line);
      line = w;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

/**
 * Builds the packet PDF. When a complete packet was uploaded as one file, that
 * file is the packet (it already has its own cover). Otherwise a cover page is
 * generated and the individual statements follow in order.
 */
export async function buildPacketPdf(periodId: string, periodType: PeriodType, viewer: Viewer) {
  const period = await prisma.bookkeepingPeriod.findUniqueOrThrow({
    where: { id: periodId },
    include: { client: { select: { displayName: true, businessName: true, fiscalYearEnd: true, bookkeepingProfile: true } } },
  });
  const reports = await packetReports(periodId, periodType, viewer);
  if (!reports.length) return null;
  const draft = reports.some((r) => r.visibility !== "PUBLISHED");
  const profile = period.client.bookkeepingProfile;
  const range = reportPeriod(period.year, period.month, periodType, period.client.fiscalYearEnd);
  const legal = profile?.legalName || period.client.businessName || period.client.displayName;
  const basisKeys = [...new Set(reports.map((r) => r.reportBasis).filter(Boolean))] as (keyof typeof BASIS)[];
  const basis = basisKeys.map((b) => BASIS[b]).join(" / ");

  const out = await PDFDocument.create();
  out.setTitle(safe(`${legal} — Financial Statements — ${range.short}`));
  out.setAuthor(safe(BUSINESS.legalName));
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const serif = await out.embedFont(StandardFonts.TimesRomanBold);
  const W = 792;
  const H = 612;

  const full = reports.find((r) => r.reportType === "FINANCIAL_PACKET");
  const parts = full ? [full] : reports;
  const generatedCover = !full;
  const usedFiles: string[] = [];

  if (generatedCover) {
    const page = out.addPage([W, H]);
    const logo = await out.embedPng(Buffer.from(LOGO_MARK_PNG_BASE64, "base64"));
    const lw = 64;
    const lh = (logo.height / logo.width) * lw;
    page.drawImage(logo, { x: (W - lw) / 2, y: H - 70 - lh, width: lw, height: lh });
    let y = H - 70 - lh - 26;
    const [firm1, ...firmRest] = BUSINESS.displayName.split(" & ");
    centered(page, firm1.toUpperCase(), y, serif, 22);
    y -= 15;
    centered(page, `& ${firmRest.join(" & ")}`.toUpperCase(), y, serif, 10);
    y -= 40;
    centered(page, legal.toUpperCase(), y, bold, 22);
    y -= 22;
    centered(page, "Financial Statements", y, bold, 14, BLUE);
    y -= 17;
    centered(page, `${range.cover}${basis ? ` • ${basis}` : ""}`, y, font, 10.5, GRAY);
    y -= 34;
    const x0 = 160;
    const x1 = 300;
    const rowW = W - 2 * x0 + 40;
    const addr = [profile?.businessAddress1, profile?.businessAddress2, [profile?.businessCity, [profile?.businessState, profile?.businessPostalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean) as string[];
    const contents = parts.map((r, i) => {
      const label = REPORT_LABELS[r.reportType!];
      const extra =
        r.reportType === "PROFIT_AND_LOSS" && r.reportIncludesYtd ? " — monthly and year-to-date total" :
        r.reportType === "BALANCE_SHEET" ? ` — as of ${longDate(r.reportAsOf ?? range.end)}` :
        r.reportType === "BANK_RECONCILIATION" && r.bookkeepingAccount ? ` — ${accountLabel(r.bookkeepingAccount)}` :
        r.reportType === "SUPPORTING_SCHEDULE" || r.reportType === "OTHER_REPORT" ? ` — ${r.title}` : "";
      return `${i + 1}. ${label}${extra}`;
    });
    const rows: [string, string[]][] = [
      ["Prepared for:", [legal, ...(profile?.dba ? [`DBA ${profile.dba}`] : []), ...(profile?.contactName ? [`${profile.contactName}${profile.contactTitle ? `, ${profile.contactTitle}` : ""}`] : []), ...addr]],
      ["Prepared by:", [BUSINESS.displayName, PACKET_TAGLINE]],
      ["Date:", [longDate(new Date())]],
      ["Contents:", contents],
    ];
    rows.forEach(([label, lines], i) => {
      const wrapped = lines.flatMap((l) => wrap(l, font, 10.5, rowW - (x1 - x0) - 10));
      page.drawText(label, { x: x0, y, size: 9.5, font: bold, color: NAVY });
      wrapped.forEach((l, k) => page.drawText(l, { x: x1, y: y - k * 15, size: 10.5, font, color: rgb(0.1, 0.1, 0.12) }));
      y -= wrapped.length * 15 + 6;
      if (i < rows.length - 1) page.drawLine({ start: { x: x0 - 8, y: y + 2 }, end: { x: x0 - 8 + rowW, y: y + 2 }, thickness: 0.6, color: RULE });
      y -= 12;
    });
    if (draft) {
      page.drawText("DRAFT — NOT APPROVED FOR CLIENT DELIVERY", { x: 150, y: 170, size: 24, font: bold, color: rgb(0.85, 0.2, 0.2), opacity: 0.18, rotate: degrees(20) });
    }
  }

  for (const r of parts) {
    const bytes = await readDocumentBytes(r.file);
    const stamp = r.visibility !== "PUBLISHED" ? `DRAFT — ${r.reviewStatus === "APPROVED" ? "approved, not yet delivered" : "awaiting Tabitha's approval"} — not for client delivery` : null;
    let added: PDFPage[] = [];
    try {
      if (!bytes || r.scanStatus !== "CLEAN") throw new Error("unavailable");
      if (r.file.mimeType === "application/pdf") {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        added = (await out.copyPages(src, src.getPageIndices())).map((p) => out.addPage(p));
      } else {
        const img = r.file.mimeType === "image/png" ? await out.embedPng(bytes) : await out.embedJpg(bytes);
        const page = out.addPage([W, H]);
        const scale = Math.min((W - 72) / img.width, (H - 100) / img.height, 1);
        page.drawImage(img, { x: (W - img.width * scale) / 2, y: (H - img.height * scale) / 2 + 10, width: img.width * scale, height: img.height * scale });
        added = [page];
      }
      usedFiles.push(r.id);
    } catch {
      const page = out.addPage([W, H]);
      centered(page, REPORT_LABELS[r.reportType!], H / 2 + 20, bold, 16);
      centered(page, r.scanStatus !== "CLEAN" ? "This file hasn't finished its security scan yet." : "This file couldn't be added to the packet. Open it on its own from the reports list.", H / 2 - 6, font, 11, GRAY);
      added = [page];
    }
    if (stamp) for (const p of added) p.drawText(safe(stamp), { x: 54, y: p.getSize().height - 18, size: 8, font: bold, color: rgb(0.75, 0.15, 0.15) });
  }

  const pages = out.getPages();
  if (generatedCover) footer(pages[0], font, 1, pages.length);
  const pdf = await out.save();
  return { pdf, reports, usedFiles, draft, filename: safe(`${legal} Financial Statements ${range.short}${draft ? " DRAFT" : ""}.pdf`).replace(/[^\w.\- ()]/g, "_") };
}
