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

You receive that client's bookkeeping data as JSON below: chart of accounts, bank and card transactions waiting to be categorized (T1, T2, ...), recently posted transactions (P1, P2, ...), the firm's categorization rules, how similar descriptions were categorized before, reconciliation status, the month-end close checklist, the ledger's warnings and the business's tax classification rules. Amounts are in dollars; money into a bank account is positive and money out is negative. On a credit card account a negative amount is a charge and a positive amount is a payment or refund. Descriptions were shortened and de-identified before they reached you.

How to answer:
- Answer like a careful senior accountant: plain language, short paragraphs or a short list, specific dates, amounts and account codes from the data. Cite transactions by their T- or P- reference.
- Use only this client's data. If the answer isn't in the data (for example, months not included, documents you can't see, other clients), say so plainly and say what would be needed.
- Never invent transactions, balances, accounts or facts. Don't guess a figure; if you estimate, say it is an estimate and show how you got it.
- You cannot post, change, approve, reconcile, close, send or delete anything, and you can't contact the client. When something should change, describe the correction (accounts, debit/credit, amount, date) and say that it needs Tabitha's approval, either through a Coetha run's drafts or a manual entry by staff.
- Apply the business's tax classification rules (taxProfile.rules) to owner draws, distributions, guaranteed payments and payroll questions.
- This is bookkeeping help, not a final tax or legal opinion; flag anything that needs Tabitha's professional judgment.`;

export type CoethaChatTurn = { role: "user" | "assistant"; text: string };
/** A file sent with the newest question: a PDF or an image (PNG, JPEG, GIF, WebP). */
export type CoethaChatFile = { mediaType: string; base64: string };
export const CHAT_FILE_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type CoethaChatResult = { text: string; inputTokens: number; outputTokens: number; requestId: string | null; model: string };

/**
 * One chat reply. `books` is the de-identified data from buildCoethaInput for ONE client; `turns`
 * is the earlier conversation (oldest first) ending with the new question. Returns text only:
 * Coetha has no tools here, so a reply can't change anything. Tests replace global fetch.
 */
export async function callCoethaChat(books: unknown, turns: CoethaChatTurn[], file?: CoethaChatFile): Promise<CoethaChatResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new CoethaModelError("Coetha needs an Anthropic API key — add ANTHROPIC_API_KEY in Netlify.", "NO_KEY");
  if (!turns.length || turns[turns.length - 1].role !== "user") throw new CoethaModelError("Ask Coetha a question first.", "BAD_REQUEST");
  const model = coethaModel();
  // Short time limit: the reply is shown while the staff member waits on the page.
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 90_000 });
  // The API expects the conversation to start with a user turn.
  const first = turns.findIndex((t) => t.role === "user");
  const messages: Anthropic.Beta.BetaMessageParam[] = turns.slice(first).map((t) => ({ role: t.role, content: t.text }));
  if (file) {
    // The file goes with the newest question, before its text.
    const block: Anthropic.Beta.BetaContentBlockParam = file.mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.base64 } }
      : { type: "image", source: { type: "base64", media_type: file.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: file.base64 } };
    const last = messages[messages.length - 1];
    last.content = [block, { type: "text", text: String(last.content) }];
  }
  let msg;
  try {
    msg = await client.beta.messages.create({
      model,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: [
        { type: "text", text: COETHA_CHAT_SYSTEM },
        { type: "text", text: `Client bookkeeping data (JSON):\n${JSON.stringify(books)}` },
      ],
      messages,
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new CoethaModelError("The Anthropic API key was refused. Check ANTHROPIC_API_KEY in Netlify.", "AUTH");
    if (err instanceof Anthropic.PermissionDeniedError) throw new CoethaModelError("The Anthropic API key isn't allowed to use this model.", "PERMISSION");
    if (err instanceof Anthropic.NotFoundError) throw new CoethaModelError(`The model "${model}" wasn't found. Check COETHA_MODEL.`, "MODEL");
    if (err instanceof Anthropic.RateLimitError) throw new CoethaModelError("Anthropic's rate limit was reached. Try again in a few minutes.", "RATE_LIMIT");
    if (err instanceof Anthropic.BadRequestError) throw new CoethaModelError("Anthropic rejected the request.", "BAD_REQUEST");
    if (err instanceof Anthropic.APIConnectionTimeoutError) throw new CoethaModelError("Coetha took too long to answer. Try a shorter or narrower question.", "TIMEOUT");
    if (err instanceof Anthropic.APIConnectionError) throw new CoethaModelError("Couldn't reach Anthropic's API.", "NETWORK");
    if (err instanceof Anthropic.APIError) throw new CoethaModelError(`Anthropic's API returned an error${err.status ? ` (${err.status})` : ""}.`, "API");
    throw new CoethaModelError("Coetha's answer couldn't be read.", "PARSE");
  }
  const requestId: string | null = (msg as { _request_id?: string | null })._request_id ?? msg.id ?? null;
  if (msg.stop_reason === "refusal") throw new CoethaModelError("Claude declined to answer this question.", "REFUSAL");
  let text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  if (!text) throw new CoethaModelError("Coetha didn't return an answer. Try asking again.", "EMPTY");
  if (msg.stop_reason === "max_tokens") text += "\n\n(Coetha's answer was cut off because it was long. Ask a narrower follow-up question for the rest.)";
  return { text, inputTokens: msg.usage.input_tokens ?? 0, outputTokens: msg.usage.output_tokens ?? 0, requestId, model: msg.model || model };
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
