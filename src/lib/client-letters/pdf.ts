import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { LOGO_MARK_PNG_BASE64 } from "@/lib/brand-logo";
import { BUSINESS } from "@/lib/business";
import type { LetterFields, LetterTemplate } from "./templates";

/**
 * A client letter on the firm's letterhead (pdf-lib, like the financial packets): the shield
 * from /public/brand (embedded as LOGO_MARK_PNG_BASE64), navy headings and a gold rule. The
 * closing is the typed team name; there is no signature image. US Letter, one or two pages.
 */

const NAVY = rgb(10 / 255, 26 / 255, 68 / 255); // #0A1A44
const GOLD = rgb(200 / 255, 157 / 255, 41 / 255); // #C89D29
const INK = rgb(0.1, 0.1, 0.12);
const GRAY = rgb(0.4, 0.42, 0.47);

const W = 612;
const H = 792;
const M = 72;
const TEXT_W = W - 2 * M;
const SIZE = 10.5;
const LEAD = 14.6;
const BOTTOM = 76;

// The standard PDF fonts cover Latin-1 and common punctuation only.
const safe = (t: string) => t.replace(/[^\x20-\x7E -ÿ–—•‘’“”…·]/g, "?");

type Run = { text: string; font: PDFFont; color?: ReturnType<typeof rgb> };

export async function buildLetterPdf(t: LetterTemplate, f: LetterFields, meta: { letterId?: string } = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(safe(`${t.documentTitle} — ${f.businessName}`));
  pdf.setAuthor(BUSINESS.legalName);
  pdf.setCreator(BUSINESS.platformName);
  pdf.setSubject(safe(t.reLine));
  // The version id (and this letter's id) travel with the file, so every filed copy is unique.
  pdf.setKeywords([t.version, ...(meta.letterId ? [meta.letterId] : [])]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const serif = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const logo = await pdf.embedPng(Buffer.from(LOGO_MARK_PNG_BASE64, "base64"));

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;

  const letterhead = () => {
    const lw = 46;
    const lh = (logo.height / logo.width) * lw;
    const top = H - 50;
    page.drawImage(logo, { x: M, y: top - lh, width: lw, height: lh });
    const x = M + lw + 14;
    page.drawText(safe(t.letterhead.name), { x, y: top - 20, size: 17, font: serif, color: NAVY });
    page.drawText(safe(t.letterhead.lines.slice(0, 2).join(" · ")), { x, y: top - 36, size: 9, font, color: GRAY });
    page.drawText(safe(t.letterhead.lines.slice(2).join(" · ")), { x, y: top - 48, size: 9, font, color: GRAY });
    const ruleY = top - Math.max(lh, 52) - 10;
    page.drawRectangle({ x: M, y: ruleY, width: TEXT_W, height: 2, color: GOLD });
    y = ruleY - 30;
  };
  const continuation = () => {
    const top = H - 50;
    page.drawText(safe(t.letterhead.name), { x: M, y: top - 12, size: 11, font: serif, color: NAVY });
    const right = safe(`${f.businessName} · ${f.date}`);
    page.drawText(right, { x: W - M - font.widthOfTextAtSize(right, 9), y: top - 12, size: 9, font, color: GRAY });
    page.drawRectangle({ x: M, y: top - 22, width: TEXT_W, height: 1.2, color: GOLD });
    y = top - 46;
  };
  const newPage = () => {
    page = pdf.addPage([W, H]);
    pages.push(page);
    if (pages.length === 1) letterhead();
    else continuation();
  };
  const ensure = (h: number) => {
    if (y - h < BOTTOM) newPage();
  };

  /** Lays out runs of mixed fonts word by word, wrapping at the text width. */
  const paragraph = (runs: Run[], opts: { indent?: number; firstPrefix?: Run; after?: number } = {}) => {
    const indent = opts.indent ?? 0;
    const words: Run[] = runs.flatMap((r) => safe(r.text).split(/\s+/).filter(Boolean).map((w) => ({ ...r, text: w })));
    const lines: Run[][] = [];
    let line: Run[] = [];
    let width = 0;
    const space = font.widthOfTextAtSize(" ", SIZE);
    for (const w of words) {
      const ww = w.font.widthOfTextAtSize(w.text, SIZE);
      if (line.length && width + space + ww > TEXT_W - indent) {
        lines.push(line);
        line = [];
        width = 0;
      }
      width += (line.length ? space : 0) + ww;
      line.push(w);
    }
    if (line.length) lines.push(line);
    lines.forEach((l, i) => {
      ensure(LEAD);
      if (i === 0 && opts.firstPrefix) page.drawText(opts.firstPrefix.text, { x: M + indent - 12, y, size: SIZE, font: opts.firstPrefix.font, color: opts.firstPrefix.color ?? GOLD });
      let x = M + indent;
      for (const w of l) {
        page.drawText(w.text, { x, y, size: SIZE, font: w.font, color: w.color ?? INK });
        x += w.font.widthOfTextAtSize(w.text, SIZE) + space;
      }
      y -= LEAD;
    });
    y -= opts.after ?? 7;
  };
  const gap = (n: number) => (y -= n);

  newPage();
  paragraph([{ text: f.date, font }], { after: 10 });
  paragraph([{ text: f.businessName, font }], { after: 0 });
  paragraph([{ text: `Attn: ${f.ownerName}`, font }], { after: 12 });
  paragraph([{ text: t.reLine, font: bold, color: NAVY }], { after: 10 });
  paragraph([{ text: `Dear ${f.ownerFirstName},`, font }]);
  for (const b of t.blocks) {
    if ("bullets" in b) {
      ensure(LEAD * 3);
      paragraph([{ text: b.lead, font: bold, color: NAVY }], { after: 3 });
      b.bullets.forEach((x, i) => paragraph([{ text: x, font }], { indent: 16, firstPrefix: { text: "•", font: bold }, after: i === b.bullets.length - 1 ? 7 : 3 }));
    } else {
      paragraph([...(b.lead ? [{ text: b.lead, font: bold, color: NAVY }] : []), { text: b.text, font }]);
    }
  }
  ensure(LEAD * 4);
  gap(3);
  paragraph([{ text: t.closing, font }], { after: 16 });
  paragraph([{ text: t.signature, font: bold, color: NAVY }], { after: 0 });

  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 52 }, end: { x: W - M, y: 52 }, thickness: 0.6, color: GOLD });
    const left = `${BUSINESS.legalName} · client.tturnerassociates.com`;
    p.drawText(left, { x: M, y: 38, size: 8, font, color: GRAY });
    const right = `Page ${i + 1} of ${pages.length}`;
    p.drawText(right, { x: W - M - font.widthOfTextAtSize(right, 8), y: 38, size: 8, font, color: GRAY });
  });
  return pdf.save();
}
