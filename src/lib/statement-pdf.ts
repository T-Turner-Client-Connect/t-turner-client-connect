/**
 * Reads the transactions printed on a bank or credit card statement PDF (pure parsing, no
 * database, nothing sent anywhere). Banks lay statements out differently, so this reads the
 * common shape: a summary (beginning and ending balance, totals by kind) and sections of dated
 * lines (deposits & credits, withdrawals / debits, fees, checks). The result is only trusted when
 * it reconciles: beginning balance + every transaction = ending balance, to the cent, and each
 * section adds up to the total the statement prints for it.
 */

export type StatementTxn = { date: string; description: string; amountCents: number; section: string };
export type StatementSummary = { beginningCents: number | null; endingCents: number | null; periodStart: string | null; periodEnd: string | null; totals: Record<string, number> };
export type StatementParse = {
  summary: StatementSummary;
  transactions: StatementTxn[];
  /** Totals the statement printed for each section ("Total Deposits & Credits $…"). */
  sectionTotals: Record<string, number>;
  check: StatementCheck;
};
export type StatementCheck = { ok: boolean; netCents: number; differenceCents: number | null; problems: string[] };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const pad = (n: number) => String(n).padStart(2, "0");
const MONEY = /\(?-?\$?\s?\d{1,3}(?:,\d{3})*\.\d{2}\)?-?/;
const MONEY_G = new RegExp(MONEY.source, "g");

export function cents(s: string): number {
  const neg = /^\(|-|\)$/.test(s.trim()) && /-|\(/.test(s);
  const n = Math.round(Number(s.replace(/[^\d.]/g, "")) * 100);
  return neg ? -n : n;
}

/** Text lines of each page, rebuilt from the PDF's positioned text (items on one baseline form one line). */
export async function pdfLines(bytes: Uint8Array): Promise<string[] | null> {
  try {
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const out: string[] = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const rows = new Map<number, { x: number; s: string }[]>();
      for (const it of tc.items as { str?: string; transform?: number[] }[]) {
        if (!it.str || !it.transform || !it.str.trim()) continue;
        const y = Math.round(it.transform[5] / 2.5);
        const row = rows.get(y) ?? [];
        row.push({ x: it.transform[4], s: it.str });
        rows.set(y, row);
      }
      for (const y of [...rows.keys()].sort((a, b) => b - a)) {
        out.push(rows.get(y)!.sort((a, b) => a.x - b.x).map((r) => r.s.trim()).join(" ").replace(/\s+/g, " ").trim());
      }
    }
    return out;
  } catch {
    return null;
  }
}

type Kind = { key: string; sign: 1 | -1; checks?: boolean };
/** Section headings and the sign their amounts carry on a bank account. */
const HEADINGS: { re: RegExp; kind: Kind }[] = [
  { re: /^(other )?deposits?( (&|and) (other )?(credits|additions))?$|^(other )?credits$|^additions$|^electronic (deposits|credits)$/, kind: { key: "DEPOSITS", sign: 1 } },
  { re: /^automatic transfers?$/, kind: { key: "TRANSFERS", sign: 1 } },
  // Credit card statements.
  { re: /^payments?( (&|and) (other )?credits)?$|^(other )?credits (&|and) payments$/, kind: { key: "PAYMENTS", sign: 1 } },
  { re: /^purchases( (&|and) (other charges|adjustments))?$|^(new )?charges$|^transactions$|^cash advances?$/, kind: { key: "PURCHASES", sign: -1 } },
  { re: /^(total )?(fees charged|interest charged)$/, kind: { key: "FEES", sign: -1 } },
  { re: /^(other |electronic |atm (and|&) debit card )?(withdrawals|debits|subtractions)( (&|and) (other )?debits)?$|^card (transactions|purchases)$|^atm( (&|and) debit card)? withdrawals$|^payments? (&|and) (other )?debits$/, kind: { key: "WITHDRAWALS", sign: -1 } },
  { re: /^(service )?(fees|charges)( (&|and) charges)?$|^service charges?$/, kind: { key: "FEES", sign: -1 } },
  { re: /^checks( paid| cleared)?$|^checks (&|and) (substitute checks|other debits)$/, kind: { key: "CHECKS", sign: -1, checks: true } },
];
const END_SECTION = /^(daily (ending )?balance|balance summary|daily balances|ending daily balance|account summary|summary|interest|overdraft|important|in case of errors|this page intentionally)/;

function headingOf(line: string): Kind | null {
  const t = line.toLowerCase().replace(/\(continued\)|continued|\(cont\.?\)/g, "").replace(/[^a-z& ]/g, " ").replace(/\s+/g, " ").trim();
  // Column titles after a heading ("Date Description Amount") are stripped.
  const bare = t.replace(/\b(date|description|amount|posted|number|check no|no)\b/g, "").replace(/\s+/g, " ").trim();
  for (const h of HEADINGS) if (h.re.test(bare)) return h.kind;
  return null;
}

/** "October 1, 2026 through October 30, 2026", "10/01/2026 - 10/30/2026", "Statement Period 10/01/26 to 10/30/26". */
function periodOf(lines: string[]) {
  for (const l of lines.slice(0, 80)) {
    const a = /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\s*(?:through|thru|to|-|–)\s*(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})/i.exec(l);
    if (a) return { start: `${a[3]}-${pad(MONTHS.indexOf(a[1].toLowerCase()) + 1)}-${pad(+a[2])}`, end: `${a[6]}-${pad(MONTHS.indexOf(a[4].toLowerCase()) + 1)}-${pad(+a[5])}` };
    const b = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*(?:through|thru|to|-|–)\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i.exec(l);
    if (b) {
      const y = (s: string) => (s.length === 2 ? `20${s}` : s);
      return { start: `${y(b[3])}-${pad(+b[1])}-${pad(+b[2])}`, end: `${y(b[6])}-${pad(+b[4])}-${pad(+b[5])}` };
    }
  }
  return null;
}

/** The first amount after a label on a summary line ("Beginning Balance $9,350.64 Minimum Balance $24,919"). */
function amountAfter(lines: string[], label: RegExp): number | null {
  for (const l of lines) {
    const m = label.exec(l);
    if (!m) continue;
    const rest = l.slice(m.index + m[0].length);
    const a = MONEY.exec(rest);
    if (a && rest.slice(0, a.index).replace(/[$:.\s]/g, "").length < 3) return cents(a[0]);
  }
  return null;
}

function ymd(m: number, d: number, y: number | null, period: { start: string; end: string } | null) {
  let year = y;
  if (year == null) {
    if (!period) return null;
    const [sy, sm] = period.start.split("-").map(Number);
    const [ey] = period.end.split("-").map(Number);
    year = sy !== ey && m < sm ? ey : sy;
  } else if (year < 100) year += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${year}-${pad(m)}-${pad(d)}`;
}

/** Parses the text lines of a statement. */
export function parseStatementLines(lines: string[], opts: { liability?: boolean } = {}): StatementParse {
  const period = periodOf(lines);
  const summary: StatementSummary = {
    beginningCents: amountAfter(lines, /\b(beginning|opening|previous|starting) balance\b/i),
    endingCents: amountAfter(lines, /\b(ending|closing|new) balance\b/i),
    periodStart: period?.start ?? null,
    periodEnd: period?.end ?? null,
    totals: {},
  };
  // The summary is everything before the first transaction section.
  const firstSection = lines.findIndex((l) => headingOf(l));
  const head = lines.slice(0, firstSection < 0 ? 60 : firstSection);
  const summaryTotal = (key: string, re: RegExp) => {
    const v = amountAfter(head, re);
    if (v != null) summary.totals[key] = Math.abs(v);
  };
  summaryTotal("DEPOSITS", /^(?:total )?(deposits (&|and) (other )?(credits|additions)|deposits|credits)\b/i);
  summaryTotal("WITHDRAWALS", /^(?:total )?(withdrawals (&|and) (other )?debits|withdrawals|(other )?debits)\b/i);
  summaryTotal("FEES", /^(?:total )?(fees (&|and) charges|fees|service charges?)\b/i);
  summaryTotal("CHECKS", /^(?:total )?checks( paid)?\b/i);
  summaryTotal("TRANSFERS", /^(?:total )?automatic transfers?\b/i);

  const transactions: StatementTxn[] = [];
  const sectionTotals: Record<string, number> = {};
  let kind: Kind | null = null;
  let last: StatementTxn | null = null;
  // A dated line whose amount is printed on a following line (a long description wrapped).
  let pending: { date: string; description: string } | null = null;
  // Money in (deposits, card payments and credits) is positive; money out (withdrawals, checks, fees,
  // card purchases and interest) is negative, on bank and card accounts alike. The section decides.
  const sign = (k: Kind) => k.sign;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const h = headingOf(line);
    if (h) { kind = h; last = null; pending = null; continue; }
    const lower = line.toLowerCase();
    if (END_SECTION.test(lower)) { kind = null; last = null; pending = null; continue; }
    if (!kind) continue;
    const total = /^total\b/i.exec(line);
    if (total) {
      const a = line.match(MONEY_G);
      if (a) sectionTotals[kind.key] = (sectionTotals[kind.key] ?? 0) + Math.abs(cents(a[a.length - 1]));
      last = null;
      pending = null;
      continue;
    }
    if (kind.checks) {
      // One or more "number [*] date amount" (or "date number amount") groups per line.
      const re = /(?:(\d{2,7})\s*\*?\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?|(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(\d{2,7})\s*\*?)\s+\$?(\d{1,3}(?:,\d{3})*\.\d{2})/g;
      let m: RegExpExecArray | null;
      let found = false;
      while ((m = re.exec(line))) {
        const num = m[1] ?? m[8];
        const date = m[1] ? ymd(+m[2], +m[3], m[4] ? +m[4] : null, period) : ymd(+m[5], +m[6], m[7] ? +m[7] : null, period);
        if (!date) continue;
        transactions.push({ date, description: `Check ${num}`, amountCents: sign(kind) * Math.abs(cents(m[9])), section: kind.key });
        found = true;
      }
      if (found) last = null;
      continue;
    }
    const t = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(.*)$/.exec(line);
    if (t) {
      const amounts = t[4].match(MONEY_G);
      if (!amounts) {
        const date = ymd(+t[1], +t[2], t[3] ? +t[3] : null, period);
        pending = date ? { date, description: t[4].trim() } : null;
        last = null;
        continue;
      }
      pending = null;
      // The transaction amount is the first amount at the end of the description; a running balance may follow it.
      const firstIdx = t[4].search(MONEY);
      const description = t[4].slice(0, firstIdx).trim();
      const date = ymd(+t[1], +t[2], t[3] ? +t[3] : null, period);
      if (!date || !description) { last = null; continue; }
      const amt = cents(amounts[0]);
      const signed = sign(kind) * Math.abs(amt);
      last = { date, description, amountCents: signed, section: kind.key };
      transactions.push(last);
      continue;
    }
    // The amount of a dated line whose description wrapped.
    if (pending) {
      const i = line.search(MONEY);
      if (i >= 0) {
        const amt = cents(line.match(MONEY)![0]);
        last = { date: pending.date, description: `${pending.description} ${line.slice(0, i).trim()}`.trim().slice(0, 200), amountCents: sign(kind) * Math.abs(amt), section: kind.key };
        transactions.push(last);
        pending = null;
      } else if (line.length < 80) pending.description = `${pending.description} ${line}`.slice(0, 200);
      continue;
    }
    // A description that wrapped onto the next line.
    if (last && !MONEY.test(line) && line.length < 80) last.description = `${last.description} ${line}`.slice(0, 200);
  }

  return { summary, transactions, sectionTotals, check: checkStatement(summary, transactions, sectionTotals, opts) };
}

/** The statement must reconcile to the cent before anything is imported. */
export function checkStatement(summary: StatementSummary, txns: StatementTxn[], sectionTotals: Record<string, number>, opts: { liability?: boolean } = {}): StatementCheck {
  const problems: string[] = [];
  const netCents = txns.reduce((n, t) => n + t.amountCents, 0);
  const usd = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (!txns.length) problems.push("No transactions could be read from the statement.");
  if (summary.beginningCents == null || summary.endingCents == null) problems.push("The statement's beginning and ending balances couldn't be found.");
  let differenceCents: number | null = null;
  if (summary.beginningCents != null && summary.endingCents != null) {
    // On a card statement the balance owed grows with charges (which are negative to the business).
    const expected = opts.liability ? summary.beginningCents - netCents : summary.beginningCents + netCents;
    differenceCents = summary.endingCents - expected;
    if (differenceCents !== 0) problems.push(`The transactions read (${usd(netCents)} net) don't account for the change from ${usd(summary.beginningCents)} to ${usd(summary.endingCents)}: ${usd(differenceCents)} is unaccounted for.`);
  }
  const bySection = (k: string) => Math.abs(txns.filter((t) => t.section === k).reduce((n, t) => n + t.amountCents, 0));
  const keys = new Set([...Object.keys(sectionTotals), ...Object.keys(summary.totals)]);
  for (const k of keys) {
    const want = sectionTotals[k] ?? summary.totals[k];
    const got = bySection(k);
    if (want !== got && !(want === 0 && got === 0)) problems.push(`${k.charAt(0) + k.slice(1).toLowerCase()} read: ${usd(got)}; the statement shows ${usd(want)}.`);
  }
  return { ok: problems.length === 0, netCents, differenceCents, problems };
}
