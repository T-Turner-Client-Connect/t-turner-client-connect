import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { usd } from "./payment-fees";
import type { AgreementTerms, AgreementSelection } from "./agreement-terms";

const NAVY = rgb(0.06, 0.12, 0.27);
const GRAY = rgb(0.35, 0.38, 0.45);

/** WinAnsi can't encode some characters (e.g. curly quotes are fine, emoji aren't). */
const safe = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[—–]/g, "-").replace(/[^\x20-\x7E -ÿ]/g, "");

function wrap(text: string, font: PDFFont, size: number, width: number) {
  const out: string[] = [];
  for (const para of safe(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/**
 * The signed agreement as a PDF: every term the client saw, the payment method
 * they chose with its fee and total, and the signature evidence (typed name,
 * Central time, version, terms fingerprint).
 */
export async function renderAgreementPdf(t: AgreementTerms, sel: AgreementSelection, sig: { signerName: string; signedAtChicago: string; ip: string | null; termsHash: string; consentText: string }) {
  const doc = await PDFDocument.create();
  doc.setTitle(`${t.agreementTitle} — ${t.clientName}`);
  doc.setAuthor(t.business);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const serif = await doc.embedFont(StandardFonts.TimesRomanBold);
  const W = 612, H = 792, M = 54, CW = W - 2 * M;
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;
  const need = (h: number) => {
    if (y - h < M) {
      page = doc.addPage([W, H]);
      y = H - M;
    }
  };
  const text = (s: string, o: { f?: PDFFont; size?: number; color?: ReturnType<typeof rgb>; gap?: number } = {}) => {
    const f = o.f ?? font, size = o.size ?? 10;
    for (const line of wrap(s, f, size, CW)) {
      need(size + 4);
      page.drawText(line, { x: M, y: y - size, size, font: f, color: o.color ?? rgb(0, 0, 0) });
      y -= size + 4;
    }
    y -= o.gap ?? 4;
  };
  const row = (left: string, right: string, f: PDFFont = font) => {
    need(16);
    page.drawText(safe(left), { x: M, y: y - 10, size: 10, font: f });
    const r = safe(right);
    page.drawText(r, { x: W - M - f.widthOfTextAtSize(r, 10), y: y - 10, size: 10, font: f });
    y -= 16;
  };

  text(t.business, { f: serif, size: 18, color: NAVY, gap: 2 });
  text(t.agreementTitle, { f: bold, size: 13, color: NAVY, gap: 10 });
  text(`Client: ${t.clientName}${t.businessName ? `   Business: ${t.businessName}` : ""}`, { f: bold });
  text(`Service: ${t.serviceTitle} (${t.serviceTypeLabel})`);
  text(t.taxYear ? `Tax year: ${t.taxYear}` : `Service period: ${t.periodLabel ?? "-"}`);
  if (t.description) text(`Description: ${t.description}`);
  text(`Agreement version ${t.version}`, { color: GRAY, gap: 10 });

  text("Price", { f: bold, size: 11, color: NAVY });
  for (const l of t.lines) row(l.label, usd(l.cents));
  row("Agreed price", usd(t.baseCents), bold);
  y -= 6;

  text("Payment options and fees", { f: bold, size: 11, color: NAVY });
  for (const o of t.options.filter((o) => o.available)) row(`${o.label}${o.feeCents ? ` (fee ${usd(o.feeCents)})` : ""}`, usd(o.totalCents));
  text("Fees apply only as shown. No fee is added after signing; changing the payment method requires a revised agreement.", { size: 8, color: GRAY, gap: 8 });

  text("Selected payment method", { f: bold, size: 11, color: NAVY });
  row(sel.label, "");
  row("Agreed price", usd(t.baseCents));
  row("Processing or transfer fee", usd(sel.feeCents));
  row("Total", usd(sel.totalCents), bold);
  if (sel.note) text(sel.note, { size: 8, color: GRAY });
  y -= 4;

  text("Payment terms", { f: bold, size: 11, color: NAVY });
  text(t.paymentTerms, { gap: 10 });

  for (const d of t.disclaimers ?? []) {
    text(d.title, { f: bold, size: 11, color: NAVY });
    text(d.text, { size: 9, gap: 10 });
  }

  text("Acknowledgment and electronic signature", { f: bold, size: 11, color: NAVY });
  text(sig.consentText);
  row("Signed by", sig.signerName, bold);
  row("Signed (Central time)", sig.signedAtChicago);
  if (sig.ip) row("Signed from IP", sig.ip);
  text(`Terms fingerprint (SHA-256): ${sig.termsHash}`, { size: 7, color: GRAY });
  return doc.save();
}
