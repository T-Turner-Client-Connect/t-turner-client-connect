/**
 * Approved client letters, as versioned constants. Pure data (no database, no "server-only") so
 * the PDF builder, the Owner's Office page and the tests read the same text.
 *
 * The wording of a version never changes. Any change to the text, however small, is a NEW
 * version id; every letter sent records the version it used (ClientLetter.templateVersion).
 * Only the bracketed fields change per client: the date, the business name, the owner's name
 * and first name.
 */

export type LetterBlock =
  /** A paragraph, optionally opening with a bold lead-in ("Why we're making this change."). */
  | { lead?: string; text: string }
  /** A bold lead-in on its own line, followed by bullet points. */
  | { lead: string; bullets: string[] };

export type LetterTemplate = {
  version: string;
  /** Title of the filed copy in the client's Document Vault. */
  documentTitle: string;
  /** Short label for the Owner's Office. */
  label: string;
  letterhead: { name: string; lines: string[] };
  reLine: string;
  blocks: LetterBlock[];
  closing: string;
  signature: string;
  /** The short email and portal message that carry the letter. */
  email: { subject: string; heading: string };
};

export type LetterFields = {
  /** The send date, already formatted ("November 6, 2026"). */
  date: string;
  businessName: string;
  ownerName: string;
  ownerFirstName: string;
};

export const BK_PORTAL_COETHA_V1: LetterTemplate = {
  version: "bk-portal-coetha-2026-11-v1",
  documentTitle: "Client letter: Bookkeeping portal & Coetha (Nov 2026)",
  label: "Bookkeeping portal & Coetha notice (November 2026)",
  letterhead: {
    name: "T. Turner & Associates, LLC",
    lines: ["1 Perimeter Park S, Suite 465S", "Birmingham, AL 35243", "205-639-1000", "info@tturnerassociates.com"],
  },
  reLine: "Re: Your bookkeeping, all in one place, and introducing Coetha",
  blocks: [
    { text: "Thank you for trusting T. Turner & Associates with your bookkeeping. We're making some improvements we think you'll appreciate." },
    {
      lead: "Why we're making this change.",
      text: "We are building a complete accounting system so everything for your business is kept in one place: TTurner Client Connect, your secure client portal. Going forward, your financial statements, documents, requests, messages and billing will all be in Client Connect, available at your fingertips whenever you need them. You'll no longer need to call, text or email to request a document or check on your books. You can see it all in your portal, any time. Of course, you are always welcome to call us.",
    },
    {
      lead: "Introducing Coetha.",
      text: "As part of this system, we'd like to introduce Coetha, the AI senior accountant assistant that helps our team keep your books accurate and on time. Coetha was built by our firm and set up for each client using that client's own bookkeeping history and our firm's rules, so the work stays consistent from month to month. Coetha runs on secure AI technology from Anthropic. It helps us sort your transactions into the right categories, prepare draft entries and spot items in your bank and credit card accounts that need attention.",
    },
    {
      lead: "What Coetha does not do.",
      text: "Coetha does not prepare, review or file tax returns. Your tax returns are prepared and filed by our firm, as always. Coetha cannot move money or make changes to your bank accounts.",
    },
    {
      lead: "How your information is protected.",
      bullets: [
        "Before any information goes to Coetha's AI service, your name is left out. Email addresses, phone numbers and Social Security or EIN-format numbers are removed, and account numbers are shortened to their last four digits.",
        "Coetha receives transaction amounts, dates and descriptions. Descriptions may include the names of businesses you paid or were paid by.",
        "Your books are handled separately from every other client's.",
        "Nothing Coetha prepares is final. Our team reviews every draft, and your financial statements are approved by our firm before they are released to you.",
      ],
    },
    {
      lead: "Getting started.",
      text: "Sign in at client.tturnerassociates.com. If you haven't set up your portal account yet, use \"Already a client? Activate your portal\" on the sign-in page, or call us and we'll help.",
    },
    {
      text: "You can read more in our Privacy Policy at client.tturnerassociates.com/privacy-policy. If you have any questions, please call us at 205-639-1000 or email info@tturnerassociates.com.",
    },
  ],
  closing: "Sincerely,",
  signature: "The T. Turner & Associates Team",
  email: {
    subject: "A letter from T. Turner & Associates about your bookkeeping",
    heading: "A letter about your bookkeeping",
  },
};

/** Every approved version, by id. A retired version stays here so letters sent with it can be re-read. */
export const LETTER_TEMPLATES: Record<string, LetterTemplate> = { [BK_PORTAL_COETHA_V1.version]: BK_PORTAL_COETHA_V1 };

/** The letter the Client Letters page prepares now. */
export const CURRENT_LETTER = BK_PORTAL_COETHA_V1;

export function letterTemplate(version: string): LetterTemplate {
  const t = LETTER_TEMPLATES[version];
  if (!t) throw new Error(`Unknown letter version ${version}`);
  return t;
}

/** The letterhead as one line, exactly as approved. */
export const letterheadLine = (t: LetterTemplate) => [t.letterhead.name, ...t.letterhead.lines].join(" · ");

/** The whole letter as plain text for one client (used for checks and the text fallback). */
export function letterText(t: LetterTemplate, f: LetterFields): string {
  const out = [letterheadLine(t), "", f.date, "", f.businessName, `Attn: ${f.ownerName}`, "", t.reLine, "", `Dear ${f.ownerFirstName},`, ""];
  for (const b of t.blocks) {
    if ("bullets" in b) out.push(b.lead, ...b.bullets.map((x) => `• ${x}`), "");
    else out.push(b.lead ? `${b.lead} ${b.text}` : b.text, "");
  }
  out.push(t.closing, "", t.signature);
  return out.join("\n");
}

/** Today in the office's time zone, as a calendar date (UTC midnight, the way @db.Date stores it). */
export function officeDay(now = new Date()): Date {
  const [m, d, y] = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "2-digit", day: "2-digit", year: "numeric" }).format(now).split("/");
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

/** "November 6, 2026" for a calendar date (from officeDay or a @db.Date column). */
export function letterDateText(day: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(day);
}
