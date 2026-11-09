import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { FIRM_NAME } from "./catalog";

const NAVY = rgb(0.06, 0.12, 0.27);
const GRAY = rgb(0.3, 0.33, 0.4);

/** WinAnsi can't encode every character (emoji, some symbols). */
const safe = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[—–]/g, "-").replace(/[^\x20-\x7E\xA0-\xFF]/g, "");

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

export type FrozenClause = { key: string; title: string; kind: "ACK" | "TERM"; version: number; text: string };
export type SignedEvidence = {
  signerName: string;
  address: string;
  phone: string;
  email: string;
  answers: { question: string; answer: string }[];
  acknowledged: string[];
  signedAtChicago: string;
  dateSigned: string;
  ip: string | null;
  userAgent: string | null;
  textHash: string;
  via: string;
  templateVersion: string;
};

/**
 * The signed agreement: the frozen text exactly as sent, each acknowledgment
 * the client ticked, their answers, the confirmed contact details, the typed
 * signature and the evidence (Central time, IP, browser, text fingerprint).
 */
export async function renderSignedAgreementPdf(a: { title: string; intro: string; clientName: string; clauses: FrozenClause[] }, ev: SignedEvidence) {
  const doc = await PDFDocument.create();
  doc.setTitle(safe(`${a.title} - ${a.clientName} (signed)`));
  doc.setAuthor(FIRM_NAME);
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
  const text = (s: string, o: { f?: PDFFont; size?: number; color?: ReturnType<typeof rgb>; gap?: number; indent?: number } = {}) => {
    const f = o.f ?? font, size = o.size ?? 10, x = M + (o.indent ?? 0);
    for (const line of wrap(s, f, size, CW - (o.indent ?? 0))) {
      need(size + 4);
      page.drawText(line, { x, y: y - size, size, font: f, color: o.color ?? rgb(0, 0, 0) });
      y -= size + 4;
    }
    y -= o.gap ?? 4;
  };
  const row = (left: string, right: string) => {
    need(16);
    page.drawText(safe(left), { x: M, y: y - 10, size: 10, font: bold });
    page.drawText(safe(right).slice(0, 90), { x: M + 150, y: y - 10, size: 10, font });
    y -= 16;
  };

  text(FIRM_NAME, { f: serif, size: 18, color: NAVY, gap: 2 });
  text(a.title, { f: bold, size: 13, color: NAVY, gap: 8 });
  text(a.intro, { gap: 10 });
  let n = 0;
  for (const c of a.clauses) {
    n++;
    const ticked = c.kind === "ACK" ? (ev.acknowledged.includes(c.key) ? "[X] " : "[ ] ") : "";
    text(`${n}. ${ticked}${c.title}`, { f: bold, size: 10, color: NAVY, gap: 1 });
    text(c.text, { indent: 14, gap: 6 });
  }
  if (ev.answers.length) {
    text("Client's answers", { f: bold, size: 11, color: NAVY });
    for (const q of ev.answers) text(`${q.question} ${q.answer}`, { gap: 2 });
    y -= 6;
  }
  text("Client information and signature", { f: bold, size: 11, color: NAVY });
  row("Full legal name", ev.signerName);
  row("Address", ev.address);
  row("Phone", ev.phone);
  row("Email", ev.email);
  row("Client signature", `/s/ ${ev.signerName}`);
  row("Date signed", ev.dateSigned);
  y -= 6;
  text("Signing record", { f: bold, size: 10, color: NAVY });
  text(`Signed electronically ${ev.signedAtChicago} (Central time) via ${ev.via}. Template version ${ev.templateVersion}.`, { size: 8, color: GRAY, gap: 1 });
  if (ev.ip) text(`IP address: ${ev.ip}`, { size: 8, color: GRAY, gap: 1 });
  if (ev.userAgent) text(`Browser: ${ev.userAgent.slice(0, 200)}`, { size: 8, color: GRAY, gap: 1 });
  text(`Agreement text fingerprint (SHA-256): ${ev.textHash}`, { size: 7, color: GRAY });
  return doc.save();
}
