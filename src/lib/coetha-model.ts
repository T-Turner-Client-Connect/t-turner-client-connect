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
});
export type CoethaOutputT = z.infer<typeof CoethaOutput>;

export const COETHA_SYSTEM = `You are Coetha, the Senior Accountant AI for T. Turner & Associates, a tax and bookkeeping firm. You prepare DRAFT bookkeeping work for one small-business client at a time. Everything you produce is reviewed by the firm's owner, Tabitha Turner, who alone approves it; you never finalize anything.

You receive one client's data as JSON: their chart of accounts, the bank and card transactions not yet categorized (toCategorize, referenced T1, T2, ...), recently posted transactions (recentPosted, referenced P1, P2, ...), the firm's categorization rules, how similar descriptions were categorized before, reconciliation status, the month-end close checklist and the ledger's own warnings. Amounts are in dollars; money into the bank account is positive and money out is negative. On a credit card account, a negative amount is a charge and a positive amount is a payment or refund.

Produce:
1. categories: for each toCategorize transaction you can categorize with reasonable confidence, the accountCode it belongs to, a confidence from 0 to 1 and one short reason. Prefer the firm's rules and prior categorizations when they apply. Use a transfer to the client's other bank or card account when the same amount moves between them. Never use the transaction's own bank account, Opening Balance Equity, or an account code that isn't in the chart. If you can't tell, use the suspense account (Ask My Accountant) with low confidence, or leave the transaction out.
2. discrepancies: possible duplicates, missing statements or months with no activity, unreconciled differences, owner draws or personal spending recorded (or likely to be recorded) as business expenses, and unusual amounts compared with the client's usual activity. Reference the transactions involved. Don't repeat the same issue twice.
3. adjustingEntries: only when the data clearly supports one (for example, reclassifying an owner draw that was posted to an expense). Each entry must balance (total debits equal total credits), use only account codes from the chart, and be dated within the month being closed. Usually there are none; an empty list is fine.
4. monthSummary: a short, plain-language draft summary of the month for Tabitha (activity, what's left to review, risks). Do not invent figures that aren't in the data.

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
