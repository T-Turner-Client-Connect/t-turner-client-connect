/**
 * Whose account is this statement for? Read from the statement's own first page (the account holder
 * name, the account number's last 4 and whether it is a card or a deposit account) and checked
 * against the client and the account it is being filed under. Never by the bank's name alone: two
 * clients can bank at the same bank and even have accounts with the same last 4.
 *
 * Outcomes:
 * - VERIFIED: this client's name and the account's last 4 are printed on the statement.
 * - MISMATCH: the statement positively belongs to a different account or a different client. It is
 *   never imported and can't be overridden; file it under the right client and account instead.
 * - UNCERTAIN: something couldn't be confirmed (no last 4 read, no name found, no last 4 on file).
 *   Nothing is imported until someone authorized confirms it.
 * Pure: no database, no network.
 */

export type StatementIdentity = {
  /** Last 4 of every account / card number printed on the statement's header lines. */
  last4s: string[];
  /** The statement's own header text, normalized (for name matching). */
  header: string;
  kind: "CARD" | "DEPOSIT" | null;
};

export type ExpectedStatementAccount = {
  /** This client's names: business name, legal name, DBA, owner name for a sole proprietor. */
  clientNames: string[];
  /** Other clients' names (to recognize a statement filed under the wrong client). */
  otherClientNames: string[];
  account: { label: string; last4: string | null; institution: string | null; accountType: string };
  /** This client's other registered accounts (to say which one the statement is really for). */
  siblings: { label: string; last4: string | null }[];
};

export type StatementAccountVerdict = { status: "VERIFIED" | "MISMATCH" | "UNCERTAIN"; reasons: string[]; readLast4: string | null };

// A transaction line ("10/02 Mobile Deposit 2,000.00") is never read as part of the header.
const TXN_LINE = /^\s*\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/;
const ACCOUNT_NO = /\b(?:account|acct|card)\b[^0-9]{0,30}?((?:[x*•.\d][x*•.\d\s-]{0,24})?\d{4})\b/gi;
const ENDING_IN = /\bending(?:\s+in)?\s*[:#]?\s*[x*•.]*\s*(\d{4})\b/gi;
// "For questions about your account call 1-800-555-0100" is a phone number, not the account.
const PHONE = /^\(?1?[-.\s]?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}$/;
const PHONES = /(?:\b1[-.\s]?)?\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;
const CARD_WORDS = /\b(minimum payment due|payment due date|credit limit|available credit|new balance|card ?member|cash advance)\b/i;
const DEPOSIT_WORDS = /\b(checking|savings|money market)\b/i;

const SUFFIX = /\b(llc|l l c|inc|incorporated|co|corp|corporation|ltd|company|pllc|pc|lp|llp|the|dba|na)\b/g;
/** Lowercase words only: "FOSCUE & ASSOCIATES, LLC (fictional)" → "foscue and associates". */
export function normalizeName(s: string) {
  return ` ${s.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(SUFFIX, " ").replace(/\s+/g, " ").trim()} `;
}

/** Reads the identifying lines of a statement (its text lines, as pdfLines returns them). */
export function readStatementIdentity(lines: string[]): StatementIdentity {
  const head: string[] = [];
  for (const raw of lines.slice(0, 160)) {
    const l = raw.trim();
    if (!l || TXN_LINE.test(l)) continue;
    head.push(l);
  }
  const last4s = new Set<string>();
  for (const line of head) {
    const l = line.replace(PHONES, " ");
    for (const re of [ACCOUNT_NO, ENDING_IN]) {
      re.lastIndex = 0;
      for (const m of l.matchAll(re)) {
        if (PHONE.test(m[1].trim())) continue;
        const digits = m[1].replace(/\D/g, "");
        if (digits.length >= 4) last4s.add(digits.slice(-4));
      }
    }
  }
  const top = head.slice(0, 60).join("\n");
  const kind = CARD_WORDS.test(top) ? "CARD" : DEPOSIT_WORDS.test(top) ? "DEPOSIT" : null;
  return { last4s: [...last4s], header: normalizeName(head.slice(0, 60).join(" ")), kind };
}

const usable = (n: string) => {
  const t = normalizeName(n).trim();
  return t.length >= 5 && (t.includes(" ") || t.length >= 6) ? ` ${t} ` : null;
};
const isCardType = (t: string) => t === "CREDIT_CARD" || t === "LINE_OF_CREDIT";
const isDepositType = (t: string) => t === "CHECKING" || t === "SAVINGS";

export function checkStatementAccount(id: StatementIdentity, exp: ExpectedStatementAccount): StatementAccountVerdict {
  const mismatch: string[] = [];
  const uncertain: string[] = [];
  const want = exp.account.last4?.replace(/\D/g, "").slice(-4) || null;
  const readLast4 = want && id.last4s.includes(want) ? want : id.last4s[0] ?? null;

  // 1. The account number.
  if (!id.last4s.length) uncertain.push("The account number couldn't be read from the statement.");
  else if (!want) uncertain.push(`${exp.account.label} has no last 4 digits on file to compare with the statement (it shows an account ending in ${id.last4s.join(" / ")}). Add the last 4 under Banking → Manage Accounts.`);
  else if (!id.last4s.includes(want)) {
    const other = exp.siblings.find((s) => s.last4 && id.last4s.includes(s.last4));
    mismatch.push(`The statement is for an account ending in ${id.last4s.join(" / ")}, not ${exp.account.label} (ending in ${want}).${other ? ` It looks like ${other.label}'s statement — file it under that account.` : ""}`);
  }

  // 2. Whose name is on it.
  const mine = exp.clientNames.map(usable).filter((n): n is string => !!n);
  const mineFound = mine.some((n) => id.header.includes(n));
  const othersFound = exp.otherClientNames.map(usable).filter((n): n is string => !!n && !mine.some((m) => m.includes(n) || n.includes(m))).some((n) => id.header.includes(n));
  if (!mineFound && othersFound) mismatch.push("The statement is in another client's name, not this business's. It wasn't imported; file it under the right client.");
  else if (!mineFound) uncertain.push("This business's name wasn't found on the statement.");

  // 3. Card vs. bank account.
  if (id.kind === "CARD" && isDepositType(exp.account.accountType)) mismatch.push(`The statement is a credit card statement, but ${exp.account.label} is a ${exp.account.accountType.toLowerCase()} account.`);
  if (id.kind === "DEPOSIT" && isCardType(exp.account.accountType) && !CARD_WORDS.test(id.header)) uncertain.push(`The statement reads like a bank account statement, but ${exp.account.label} is a credit card.`);

  if (mismatch.length) return { status: "MISMATCH", reasons: mismatch, readLast4 };
  if (uncertain.length) return { status: "UNCERTAIN", reasons: uncertain, readLast4 };
  return { status: "VERIFIED", reasons: [], readLast4 };
}
