import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { chatError, coethaModel, CoethaModelError } from "./coetha-model";

/**
 * Coetha's audit readers: the notice, the filed return's reported amounts, and supporting documents.
 * Each is read-only, returns structured data, and never guesses: anything unclear comes back as a
 * flag. Documents go as text with identifiers removed (redact) whenever they have a text layer; a
 * picture or scanned page with no text goes as the image, with the instruction never to repeat
 * identifiers. Tests replace these readers (setAuditReaders).
 */

/** Removes SSNs/ITINs, EINs and long account numbers from text before it leaves Client Connect. */
export function redact(text: string) {
  return text
    .replace(/\b\d{3}[- ]\d{2}[- ]\d{4}\b/g, "[SSN removed]")
    .replace(/\b\d{2}-\d{7}\b/g, "[EIN removed]")
    .replace(/\b\d{9}\b/g, "[ID removed]")
    .replace(/\b\d{10,17}\b/g, (m) => `[account ending ${m.slice(-4)}]`);
}

export type AuditDoc = { kind: "text"; text: string } | { kind: "file"; mediaType: string; base64: string };

export const NoticeReading = z.object({
  agency: z.enum(["IRS", "STATE", "OTHER", "UNCLEAR"]),
  stateCode: z.string().nullable().describe("Two-letter state for a state agency, else null"),
  taxYear: z.number().int().nullable().describe("The tax year the notice concerns; null if not stated"),
  noticeNumber: z.string().nullable().describe("Notice or letter number as printed (e.g. CP2000, Letter 566); null if none"),
  auditType: z.string().nullable().describe("Correspondence examination, office audit, field audit, adjustment notice... as stated; null if not stated"),
  responseDeadline: z.string().nullable().describe("YYYY-MM-DD only if a specific response date is printed; null otherwise"),
  respondTo: z.string().nullable().describe("Office name and mailing address (or fax/portal) to respond to, exactly as printed; null if not given"),
  instructions: z.string().nullable().describe("How the agency says to respond (what to include, copies not originals, forms to sign...), in short sentences; null if none"),
  items: z.array(z.object({
    label: z.string().describe("The item being examined, in plain words (e.g. 'Gifts to charity')"),
    form: z.string().nullable().describe("The return form or schedule it is on as named by the notice (Schedule A, Schedule C, Form 1040, Alabama Form 40...), or null"),
    line: z.string().nullable().describe("Line number if the notice gives one, else null"),
    amountOnNotice: z.number().nullable().describe("Dollar amount the notice cites for this item, if any"),
    documentsRequested: z.string().nullable().describe("What the notice asks the taxpayer to provide for this item, if stated"),
  })),
  unclear: z.array(z.string()).describe("Anything you could not read or determine with certainty, one short sentence each. Empty if everything is clear."),
});
export type NoticeReadingT = z.infer<typeof NoticeReading>;

export const ReturnAmounts = z.object({
  items: z.array(z.object({
    ref: z.string().describe("The item ref as given (I1, I2...)"),
    amount: z.number().nullable().describe("Amount in dollars printed on the return for this item; null if not found"),
    where: z.string().nullable().describe("Form, line and page where it is printed"),
    note: z.string().nullable().describe("Why it's null or uncertain, if so"),
  })),
});
export type ReturnAmountsT = z.infer<typeof ReturnAmounts>;

export const SupportReading = z.object({
  kind: z.string().describe("What the document is (receipt, Form 1098, Form W-2, bank statement, invoice, mileage log...)"),
  matches: z.array(z.object({
    ref: z.string().describe("The audit item ref it supports (I1, I2...)"),
    amount: z.number().nullable().describe("The dollar amount this document itself shows for that item; null if it supports the item without a usable amount"),
    why: z.string().describe("One short factual sentence: what in the document supports the item"),
  })).describe("Empty when the document doesn't support any listed item"),
  taxYearShown: z.number().int().nullable().describe("The year the document is for, if shown"),
});
export type SupportReadingT = z.infer<typeof SupportReading>;

const RULES = `Rules: copy amounts, dates and names exactly as shown; never guess or fill in; if something is unreadable or ambiguous, say so. Never output Social Security numbers, tax ID numbers, or full bank account numbers.`;

async function parse<T extends z.ZodTypeAny>(schema: T, system: string, content: Anthropic.Beta.BetaContentBlockParam[], what: string): Promise<z.infer<T>> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new CoethaModelError("Coetha needs an Anthropic API key — add ANTHROPIC_API_KEY in Netlify.", "NO_KEY");
  const model = coethaModel();
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 120_000 });
  let msg;
  try {
    msg = await client.beta.messages.parse({ model, max_tokens: 6000, output_config: { effort: "low", format: betaZodOutputFormat(schema) }, system, messages: [{ role: "user", content }] });
  } catch (err) {
    throw chatError(err, model);
  }
  if (msg.stop_reason === "refusal") throw new CoethaModelError(`Claude declined to read the ${what}.`, "REFUSAL");
  if (msg.stop_reason === "max_tokens") throw new CoethaModelError(`The ${what} is too long to read at once.`, "MAX_TOKENS");
  if (!msg.parsed_output) throw new CoethaModelError(`The ${what} wasn't returned in the expected format.`, "PARSE");
  return msg.parsed_output;
}

const block = (d: AuditDoc): Anthropic.Beta.BetaContentBlockParam =>
  d.kind === "text"
    ? { type: "text", text: d.text }
    : d.mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: d.base64 } }
      : { type: "image", source: { type: "base64", media_type: d.mediaType as "image/png" | "image/jpeg", data: d.base64 } };

export const realReaders = {
  notice: (doc: AuditDoc) =>
    parse(NoticeReading, `You are Coetha, Senior Accountant at a tax firm. You read an IRS or state tax agency notice about an examination (audit) and report exactly what it says: agency, tax year, notice number, type of audit, the response deadline, where and how to respond, each return item being examined and the documents requested for it. List as unclear anything you can't determine with certainty. ${RULES}`, [block(doc), { type: "text", text: "Read this notice." }], "notice"),
  returnAmounts: (pages: string, items: { ref: string; label: string; form: string | null; line: string | null }[]) =>
    parse(ReturnAmounts, `You are Coetha, Senior Accountant at a tax firm. You are given the text of a FILED tax return (identifiers removed) and the items an agency is examining. For each item, give the amount printed on the return for it, and where. If an item isn't on the return or the amount is unclear, return null and say why. Do not compute or infer amounts that are not printed. ${RULES}`, [{ type: "text", text: `Items:\n${items.map((i) => `${i.ref}: ${i.label}${i.form ? ` (${i.form}${i.line ? ` line ${i.line}` : ""})` : ""}`).join("\n")}\n\nFiled return text:\n${pages}` }], "return"),
  support: (doc: AuditDoc, taxYear: number | null, items: { ref: string; label: string; requested: string | null }[]) =>
    parse(SupportReading, `You are Coetha, Senior Accountant at a tax firm preparing an audit response. Decide whether this one document supports any of the audit items listed, and the amount the document itself shows for each item it supports. Only count an amount the document actually shows for the tax year under examination${taxYear ? ` (${taxYear})` : ""}; if the document is for another year or doesn't support an item, return no match. ${RULES}`, [block(doc), { type: "text", text: `Audit items:\n${items.map((i) => `${i.ref}: ${i.label}${i.requested ? ` — agency asked for: ${i.requested}` : ""}`).join("\n")}\n\nWhich items does this document support, and for what amounts?` }], "document"),
};

let readers = realReaders;
export const auditReaders = () => readers;
/** Tests only. */
export function setAuditReaders(r: Partial<typeof realReaders> | null) {
  readers = r ? { ...realReaders, ...r } : realReaders;
}
