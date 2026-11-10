import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

/**
 * The one place Client Connect talks to Claude (Anthropic API) for Coetha. It receives only the
 * minimized, de-identified bookkeeping data built in services/coetha.ts and returns structured
 * proposals. It never touches the database: nothing it returns is posted until Tabitha approves.
 *
 * Data goes to Anthropic's API under the firm's own API key (ANTHROPIC_API_KEY in Netlify).
 */

export const DEFAULT_COETHA_MODEL = "claude-sonnet-5-5";
export const coethaModel = () => process.env.COETHA_MODEL?.trim() || DEFAULT_COETHA_MODEL;
export const coethaKeyPresent = () => !!process.env.ANTHROPIC_API_KEY?.trim();

export const RECOMMENDATION_CATEGORIES = ["INCORRECT_CLASSIFICATION", "DUPLICATE", "MISSING_ENTRY", "OWNER_DRAW", "SHAREHOLDER_DISTRIBUTION", "PARTNER_DRAW", "GUARANTEED_PAYMENT", "PAYROLL", "UNRECORDED_LIABILITY", "LOAN_PAYMENT_AS_EXPENSE", "CARD_PAYMENT_DOUBLE_COUNTED", "UNRECONCILED", "CLASSIFICATION_INCONSISTENCY", "OTHER"] as const;
export const DISCREPANCY_TYPES = ["POSSIBLE_DUPLICATE", "MISSING_STATEMENT", "UNRECONCILED_DIFFERENCE", "OWNER_DRAW_VS_EXPENSE", "UNUSUAL_AMOUNT", "OTHER"] as const;

export const CoethaOutput = z.object({
  categories: z.array(
    z.object({
      ref: z.string().describe("The T-reference of a transaction from toCategorize, e.g. T3"),
      accountCode: z.string().describe("Code of one of the client's accounts from the chart of accounts"),
      confidence: z.number().describe("0 to 1"),
      reason: z.string().describe("One short sentence"),
    }),
  ),
  discrepancies: z.array(
    z.object({
      type: z.enum(DISCREPANCY_TYPES),
      severity: z.enum(["HIGH", "MEDIUM", "LOW"]),
      title: z.string(),
      detail: z.string(),
      refs: z.array(z.string()).describe("T- or P-references of the transactions involved; may be empty"),
    }),
  ),
  adjustingEntries: z.array(
    z.object({
      date: z.string().describe("YYYY-MM-DD"),
      memo: z.string(),
      reason: z.string(),
      confidence: z.number().describe("0 to 1"),
      lines: z.array(z.object({ accountCode: z.string(), debit: z.number().describe("dollars, 0 if credit"), credit: z.number().describe("dollars, 0 if debit"), description: z.string() })),
    }),
  ),
  monthSummary: z.object({ month: z.string().describe("YYYY-MM"), summary: z.string(), highlights: z.array(z.string()) }),
  recommendations: z.array(
    z.object({
      category: z.enum(RECOMMENDATION_CATEGORIES),
      title: z.string(),
      found: z.string().describe("What you found, with dates and amounts from the data"),
      why: z.string().describe("Why it needs attention (tie it to the tax classification rules when relevant)"),
      correction: z.string().describe("The proposed correction, in plain words"),
      accountCodes: z.array(z.string()).describe("Codes of the accounts affected, from the chart"),
      refs: z.array(z.string()).describe("T- or P-references of the supporting transactions; may be empty"),
      impact: z.string().describe("The potential effect on the P&L and Balance Sheet"),
    }),
  ).optional(),
  classificationRecommendation: z
    .array(z.object({ recommended: z.enum(["FORM_1065", "FORM_1120S", "SCHEDULE_C", "OTHER_REVIEW"]), why: z.string() }))
    .describe("Empty unless the data clearly suggests the business's tax classification is wrong; at most one item")
    .optional(),
});
export type CoethaOutputT = z.infer<typeof CoethaOutput>;

export const COETHA_SYSTEM = `You are Coetha, the Senior Accountant AI for T. Turner & Associates, a tax and bookkeeping firm. You prepare DRAFT bookkeeping work for one small-business client at a time. Everything you produce is reviewed by the firm's owner, Tabitha Turner, who alone approves it; you never finalize anything.

You receive one client's data as JSON: their chart of accounts, the bank and card transactions not yet categorized (toCategorize, referenced T1, T2, ...), recently posted transactions (recentPosted, referenced P1, P2, ...), the firm's categorization rules, how similar descriptions were categorized before, reconciliation status, the month-end close checklist and the ledger's own warnings. Amounts are in dollars; money into the bank account is positive and money out is negative. On a credit card account, a negative amount is a charge and a positive amount is a payment or refund.

Produce:
1. categories: for each toCategorize transaction you can categorize with reasonable confidence, the accountCode it belongs to, a confidence from 0 to 1 and one short reason. Prefer the firm's rules and prior categorizations when they apply. Use a transfer to the client's other bank or card account when the same amount moves between them. Never use the transaction's own bank account, Opening Balance Equity, or an account code that isn't in the chart. If you can't tell, use the suspense account (Ask My Accountant) with low confidence, or leave the transaction out.
2. discrepancies: possible duplicates, missing statements or months with no activity, unreconciled differences, owner draws or personal spending recorded (or likely to be recorded) as business expenses, and unusual amounts compared with the client's usual activity. Reference the transactions involved. Don't repeat the same issue twice.
3. adjustingEntries: only when the data clearly supports one (for example, reclassifying an owner draw that was posted to an expense). Each entry must balance (total debits equal total credits), use only account codes from the chart, and be dated within the month being closed. Usually there are none; an empty list is fine.
4. monthSummary: a short, plain-language draft summary of the month for Tabitha (activity, what's left to review, risks). Do not invent figures that aren't in the data.
5. recommendations: the issues a senior accountant would raise — incorrect classifications, duplicates, missing journal entries, owner draws / shareholder distributions / partner draws / guaranteed payments versus expenses and payroll, unrecorded liabilities, loan payments booked as expenses, credit card payments double-counted as expenses, unreconciled accounts and anything inconsistent with the tax classification. For each, state what you found, why it needs attention, the proposed correction, the accounts affected, the supporting transactions and the potential financial statement impact.
6. classificationRecommendation: only if the data clearly contradicts the business's tax classification. You never change it; Tabitha decides.

The business's tax classification (taxProfile) decides the equity and compensation rules you apply (taxProfile.rules). Apply them: e.g. an S corporation's owner withdrawals are shareholder distributions and its owners need reasonable compensation through payroll; a partnership's are partner draws against each partner's capital account and fixed payments for services are guaranteed payments; a Schedule C owner's are owner draws.

Be conservative and specific. Never invent transactions, balances, accounts or facts.`;

export type CoethaCallResult = { output: CoethaOutputT; inputTokens: number; outputTokens: number; requestId: string | null; model: string };

export class CoethaModelError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "CoethaModelError";
  }
}

/** Calls Claude with structured output. Tests replace global fetch; nothing here is mocked in-process. */
export async function callCoethaModel(input: unknown): Promise<CoethaCallResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new CoethaModelError("Coetha needs an Anthropic API key — add ANTHROPIC_API_KEY in Netlify.", "NO_KEY");
  const model = coethaModel();
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 5 * 60_000 });
  let msg;
  try {
    msg = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      // If a safety classifier declines, the API retries on its default fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: betaZodOutputFormat(CoethaOutput) },
      system: COETHA_SYSTEM,
      messages: [{ role: "user", content: `Client bookkeeping data (JSON):\n${JSON.stringify(input)}` }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new CoethaModelError("The Anthropic API key was refused. Check ANTHROPIC_API_KEY in Netlify.", "AUTH");
    if (err instanceof Anthropic.PermissionDeniedError) throw new CoethaModelError("The Anthropic API key isn't allowed to use this model.", "PERMISSION");
    if (err instanceof Anthropic.NotFoundError) throw new CoethaModelError(`The model "${model}" wasn't found. Check COETHA_MODEL.`, "MODEL");
    if (err instanceof Anthropic.RateLimitError) throw new CoethaModelError("Anthropic's rate limit was reached. Try again in a few minutes.", "RATE_LIMIT");
    if (err instanceof Anthropic.BadRequestError) throw new CoethaModelError("Anthropic rejected the request.", "BAD_REQUEST");
    if (err instanceof Anthropic.APIConnectionError) throw new CoethaModelError("Couldn't reach Anthropic's API.", "NETWORK");
    if (err instanceof Anthropic.APIError) throw new CoethaModelError(`Anthropic's API returned an error${err.status ? ` (${err.status})` : ""}.`, "API");
    throw new CoethaModelError("Coetha's answer couldn't be read.", "PARSE");
  }
  // Anthropic's request id when the SDK keeps it, otherwise the message id (either one identifies the call for support).
  const requestId: string | null = (msg as { _request_id?: string | null })._request_id ?? msg.id ?? null;
  if (msg.stop_reason === "refusal") throw new CoethaModelError("Claude declined this request.", "REFUSAL");
  if (msg.stop_reason === "max_tokens") throw new CoethaModelError("Coetha's answer was too long and was cut off. Try again with fewer transactions waiting.", "MAX_TOKENS");
  if (!msg.parsed_output) throw new CoethaModelError("Coetha's answer wasn't in the expected format.", "PARSE");
  return { output: msg.parsed_output, inputTokens: msg.usage.input_tokens ?? 0, outputTokens: msg.usage.output_tokens ?? 0, requestId, model: msg.model || model };
}

// --- "Ask Coetha": a back-and-forth conversation about ONE client's books ------------------------

export const COETHA_CHAT_SYSTEM = `You are Coetha, the Senior Accountant AI for T. Turner & Associates, a tax and bookkeeping firm. You are talking with the firm's own staff (Tabitha Turner, the owner, or a bookkeeper she assigned) about ONE small-business client's books.

You receive two JSON blocks below.
1. "Books": the chart of accounts, the firm's categorization rules, how descriptions were categorized before, the month-end close checklist, the ledger's warnings and the business's tax classification rules.
2. "Records": the complete list of what is still open, read fresh for this question:
   - waitingRows (W1, W2, ...): EVERY bank and card row not yet posted or excluded, each with the draft already prepared for it (proposed account, where the draft came from, whether it needs Tabitha's judgment, the completed-statement line it matched) or null when nothing is drafted.
   - counts: totals by account and status, and waiting rows by account and month. "definitions" says exactly how each screen counts, so you can explain why two numbers differ (for example the ledger warning vs. the cash proof).
   - excludedRows, cashProof (per bank account: statement balance to books, line by line), draftsReadyToApprove, judgmentGroups, comparisonWithCompletedStatements (books minus statements, by line and month), vendorFamilyPostingsToReview and documentsOnFile (titles only; you can't read their contents unless a file is attached to the question).
Amounts are in dollars; money into a bank account is positive and money out is negative. On a credit card account a negative amount is a charge and a positive amount is a payment or refund. Descriptions were shortened and de-identified before they reached you.

You also have two read-only search tools for the whole history (posted rows, earlier months, journal entries). Use them only when the Records block doesn't already answer the question, with narrow filters (dates, account, words, amounts). Each call returns at most 100 rows and the total.

How to answer:
- Do the research yourself from these records; don't ask staff to look things up or re-enter what is already here.
- When asked what is unresolved, group the open items by what they are (for example checks without a payee, card payments, owner transfers, transfers between accounts, deposits to identify, disputes, fees), with count and total for each group and the W-references, then say for each group what evidence would settle it and which decision only Tabitha can make. Put the decisions that need her at the end, short and numbered.
- Plain language, short paragraphs or short lists, specific dates, amounts and account codes. Cite rows by their W-reference.
- Use only this client's data. If something isn't in the data, say so plainly and what would be needed.
- Never invent transactions, balances, accounts or facts. If you estimate, say so and show how.
- You cannot post, change, approve, reverse, reconcile, close, send or delete anything, and you can't contact the client. When something should change, describe the correction (accounts, debit/credit, amount, date) and say it needs Tabitha's approval.
- Apply the business's tax classification rules (taxProfile.rules) to owner draws, distributions, guaranteed payments and payroll questions.
- This is bookkeeping help, not a final tax or legal opinion; flag anything that needs Tabitha's professional judgment.`;

export type CoethaChatTurn = { role: "user" | "assistant"; text: string };
export type CoethaChatResult = { text: string; inputTokens: number; outputTokens: number; requestId: string | null; model: string; searches: number };
/** Read-only tools for one answer: their definitions and the function that runs them for ONE business. */
export type CoethaChatTools = { defs: Anthropic.Beta.BetaTool[]; run: (name: string, input: unknown) => Promise<unknown>; records?: unknown };
/** At most this many search rounds per answer, and no new round after this long (the page waits). */
export const CHAT_MAX_SEARCH_ROUNDS = 3;
const CHAT_SEARCH_BUDGET_MS = 35_000;

/** An API failure as the plain-language error staff see. */
function chatError(err: unknown, model: string): CoethaModelError {
  // The service's own reason goes to the server log (no client data is in it) so a refusal can be traced.
  if (err instanceof Anthropic.APIError) console.error(`coetha: AI service HTTP ${err.status ?? "?"}: ${String(err.message).slice(0, 300)}`);
  if (err instanceof Anthropic.AuthenticationError) return new CoethaModelError("The Anthropic API key was refused. Check ANTHROPIC_API_KEY in Netlify.", "AUTH");
  // On this site requests go through Netlify's AI Gateway, which also answers 403 when it refuses a request (for example a usage limit).
  if (err instanceof Anthropic.PermissionDeniedError) return new CoethaModelError("The AI service refused the request (403). If it keeps happening, check the AI Gateway usage and limits in Netlify; the reason is in the site's function log.", "PERMISSION");
  if (err instanceof Anthropic.NotFoundError) return new CoethaModelError(`The model "${model}" wasn't found. Check COETHA_MODEL.`, "MODEL");
  if (err instanceof Anthropic.RateLimitError) return new CoethaModelError("Anthropic's rate limit was reached. Try again in a few minutes.", "RATE_LIMIT");
  if (err instanceof Anthropic.BadRequestError) return new CoethaModelError("Anthropic rejected the request.", "BAD_REQUEST");
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new CoethaModelError("Coetha took too long to answer. Try a shorter or narrower question.", "TIMEOUT");
  if (err instanceof Anthropic.APIConnectionError) return new CoethaModelError("Couldn't reach Anthropic's API.", "NETWORK");
  if (err instanceof Anthropic.APIError) return new CoethaModelError(`Anthropic's API returned an error${err.status ? ` (${err.status})` : ""}.`, "API");
  return new CoethaModelError("Coetha's answer couldn't be read.", "PARSE");
}
/**
 * A file sent with the newest question: the text read from a PDF (statements, invoices: small and
 * de-identified), or the file itself for a picture or a scanned PDF (PNG, JPEG, GIF, WebP, PDF).
 */
export type CoethaChatFile = { mediaType: string; base64: string } | { name: string; text: string };
export const CHAT_FILE_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/**
 * One chat reply. `books` is the de-identified data from buildCoethaInput for ONE client; `turns`
 * is the earlier conversation (oldest first) ending with the new question. Returns text only:
 * Coetha's only tools are read-only searches of the same business (tools.run is bound to it), so
 * a reply can't change anything. Tests replace global fetch.
 */
export async function callCoethaChat(books: unknown, turns: CoethaChatTurn[], tools?: CoethaChatTools, files: CoethaChatFile[] = []): Promise<CoethaChatResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new CoethaModelError("Coetha needs an Anthropic API key — add ANTHROPIC_API_KEY in Netlify.", "NO_KEY");
  if (!turns.length || turns[turns.length - 1].role !== "user") throw new CoethaModelError("Ask Coetha a question first.", "BAD_REQUEST");
  const model = coethaModel();
  // Short time limit: the reply is shown while the staff member waits on the page.
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 90_000 });
  // The API expects the conversation to start with a user turn.
  const first = turns.findIndex((t) => t.role === "user");
  const messages: Anthropic.Beta.BetaMessageParam[] = turns.slice(first).map((t) => ({ role: t.role, content: t.text }));
  if (files.length) {
    // The files go with the newest question, before its text.
    const blocks: Anthropic.Beta.BetaContentBlockParam[] = files.map((file) => ("text" in file
      ? { type: "text", text: `Attached file “${file.name}” (its text, read from the PDF; long numbers shortened to the last 4 digits):\n${file.text}` }
      : file.mediaType === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.base64 } }
        : { type: "image", source: { type: "base64", media_type: file.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: file.base64 } }));
    const last = messages[messages.length - 1];
    last.content = [...blocks, { type: "text", text: String(last.content) }];
  }
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: COETHA_CHAT_SYSTEM },
    { type: "text", text: `Books (JSON):\n${JSON.stringify(books)}` },
    ...(tools?.records !== undefined ? [{ type: "text" as const, text: `Records (JSON):\n${JSON.stringify(tools.records)}` }] : []),
  ];
  const started = Date.now();
  let inputTokens = 0, outputTokens = 0, searches = 0;
  let msg: Anthropic.Beta.BetaMessage;
  for (let round = 0; ; round++) {
    // The last allowed round (or when time is short) can't search again: Coetha answers with what she has.
    const mayUseTools = !!tools && round < CHAT_MAX_SEARCH_ROUNDS && Date.now() - started < CHAT_SEARCH_BUDGET_MS;
    try {
      msg = await client.beta.messages.create({
        model,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system,
        messages,
        ...(tools?.defs.length ? { tools: tools.defs, tool_choice: mayUseTools ? { type: "auto" as const } : { type: "none" as const } } : {}),
      });
    } catch (err) {
      throw chatError(err, model);
    }
    inputTokens += msg.usage.input_tokens ?? 0;
    outputTokens += msg.usage.output_tokens ?? 0;
    const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (msg.stop_reason !== "tool_use" || !calls.length || !tools) break;
    searches += calls.length;
    messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const c of calls) {
      let out: unknown;
      try { out = await tools.run(c.name, c.input); } catch { out = { error: "That search couldn't be completed." }; }
      results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
  const requestId: string | null = (msg as { _request_id?: string | null })._request_id ?? msg.id ?? null;
  if (msg.stop_reason === "refusal") throw new CoethaModelError("Claude declined to answer this question.", "REFUSAL");
  let text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  if (!text) throw new CoethaModelError("Coetha didn't return an answer. Try asking again.", "EMPTY");
  if (msg.stop_reason === "max_tokens") text += "\n\n(Coetha's answer was cut off because it was long. Ask a narrower follow-up question for the rest.)";
  return { text, inputTokens, outputTokens, requestId, model: msg.model || model, searches };
}

// --- Reading a statement's transactions when the layout isn't recognized -------------------------

export const StatementOutput = z.object({
  beginningBalance: z.number().nullable().describe("dollars, as printed; null if not shown"),
  endingBalance: z.number().nullable().describe("dollars, as printed; null if not shown"),
  transactions: z.array(
    z.object({
      date: z.string().describe("YYYY-MM-DD"),
      description: z.string(),
      amount: z.number().describe("dollars: positive for money in (deposits, credits, card payments), negative for money out (withdrawals, checks, fees, card purchases, interest)"),
      section: z.enum(["DEPOSITS", "WITHDRAWALS", "CHECKS", "FEES", "TRANSFERS", "PAYMENTS", "PURCHASES"]),
    }),
  ),
});
export type StatementOutputT = z.infer<typeof StatementOutput>;

const STATEMENT_SYSTEM = `You read the transaction lines of ONE bank or credit card statement for a bookkeeping firm. You receive the statement's text lines (personal details and account numbers were removed). List every transaction exactly as printed: date (use the statement period to supply the year), description and amount, with money in positive and money out negative, and the section it is printed in. Include every check, fee and interest charge. Do not include daily balance listings, running balances, summaries or totals. Never invent, merge or skip a transaction; copy amounts exactly.`;

/** Asks Claude to list a statement's transactions (text only, de-identified). The caller verifies the result reconciles to the cent. */
export async function callStatementReader(lines: string[], period: string | null): Promise<{ output: StatementOutputT; model: string; inputTokens: number; outputTokens: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new CoethaModelError("Coetha needs an Anthropic API key — add ANTHROPIC_API_KEY in Netlify.", "NO_KEY");
  const model = coethaModel();
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 120_000 });
  let msg;
  try {
    msg = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(StatementOutput) },
      system: STATEMENT_SYSTEM,
      messages: [{ role: "user", content: `Statement period: ${period ?? "not found"}\n\nStatement text:\n${lines.join("\n")}` }],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) throw new CoethaModelError(`Anthropic's API returned an error${err.status ? ` (${err.status})` : ""}.`, "API");
    throw new CoethaModelError("The statement couldn't be read.", "PARSE");
  }
  if (msg.stop_reason === "refusal") throw new CoethaModelError("Claude declined to read this statement.", "REFUSAL");
  if (msg.stop_reason === "max_tokens") throw new CoethaModelError("The statement has too many transactions to read at once.", "MAX_TOKENS");
  if (!msg.parsed_output) throw new CoethaModelError("The statement's transactions weren't returned in the expected format.", "PARSE");
  return { output: msg.parsed_output, model: msg.model || model, inputTokens: msg.usage.input_tokens ?? 0, outputTokens: msg.usage.output_tokens ?? 0 };
}

// --- Reading documents (background) -------------------------------------------------------------

export const DocumentFindings = z.object({
  items: z.array(z.object({
    page: z.number().int().describe("Page number within the pages sent, starting at 1"),
    kind: z.enum(["CHECK", "DEPOSIT", "RECEIPT", "INVOICE", "STATEMENT", "OTHER"]),
    checkNumber: z.string().nullable().describe("Check number as printed, digits only; null if not a check"),
    date: z.string().nullable().describe("Date written on the item, YYYY-MM-DD; null if none"),
    payee: z.string().nullable().describe("Pay to the order of / vendor / from whom; null if none"),
    amount: z.number().nullable().describe("Amount in dollars as written; null if unreadable"),
    memo: z.string().nullable().describe("Memo or purpose line; null if blank"),
    details: z.string().nullable().describe("Anything else useful: endorsement or deposit stamp (bank and date), void, blank page, unreadable parts. Never account or routing numbers."),
  })),
});
export type DocumentFindingsT = z.infer<typeof DocumentFindings>;

const DOCUMENT_SYSTEM = `You read scanned pages for a bookkeeping firm: check images (front and back), deposit slips, receipts, invoices and statements. For every item on every page, return one entry with its page number (1 = the first page you were sent), the kind of item, and what is written: check number, date, payee, amount, memo, and other useful details such as an endorsement or a bank deposit stamp with its date, "void", or "blank page".
Rules:
- Copy numbers and names exactly as written; if something is unreadable, use null and say so in details. Never guess.
- Never output a full bank account number or routing number. If one matters, give only its last 4 digits (for example "account ending 9432").
- Never describe or transcribe signatures beyond "signed" or "not signed". Never output Social Security or tax ID numbers.
- A blank page gets one entry: kind OTHER, details "blank page".`;

/**
 * Reads one small batch of pages (a PDF of a few pages, or one picture) and returns what is on
 * them as structured items. Read-only: no tools. Tests replace global fetch.
 */
export async function callDocumentReader(file: CoethaChatFile & { mediaType: string; base64: string }, opts: { timeoutMs?: number } = {}): Promise<{ output: DocumentFindingsT; inputTokens: number; outputTokens: number; model: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new CoethaModelError("Coetha needs an Anthropic API key — add ANTHROPIC_API_KEY in Netlify.", "NO_KEY");
  const model = coethaModel();
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: opts.timeoutMs ?? 120_000 });
  const block: Anthropic.Beta.BetaContentBlockParam = file.mediaType === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.base64 } }
    : { type: "image", source: { type: "base64", media_type: file.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: file.base64 } };
  let msg;
  try {
    msg = await client.beta.messages.parse({
      model,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(DocumentFindings) },
      system: DOCUMENT_SYSTEM,
      messages: [{ role: "user", content: [block, { type: "text", text: "List every item on these pages." }] }],
    });
  } catch (err) {
    throw chatError(err, model);
  }
  if (msg.stop_reason === "refusal") throw new CoethaModelError("Claude declined to read these pages.", "REFUSAL");
  if (msg.stop_reason === "max_tokens") throw new CoethaModelError("These pages hold too many items to read at once.", "MAX_TOKENS");
  if (!msg.parsed_output) throw new CoethaModelError("The pages weren't returned in the expected format.", "PARSE");
  return { output: msg.parsed_output, inputTokens: msg.usage.input_tokens ?? 0, outputTokens: msg.usage.output_tokens ?? 0, model: msg.model || model };
}
