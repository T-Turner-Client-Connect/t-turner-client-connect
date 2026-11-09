"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { dateOrNull, run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { archiveManualAccount, createManualAccount, enterManualBalance, enterManualBalances, morningImport, updateManualAccountLinks } from "@/lib/services/manual-bank";
import { usd } from "@/lib/services/ledger";
import { fmtChicago } from "@/lib/tz";
import { RepeatedSubmission } from "@/lib/services/office-actions";
import { fileStatement } from "@/lib/services/office-statements";
import { readAfterUpload } from "@/lib/services/statement-import";

/** A double-click or retry of the same form: report it as already saved, not an error. */
async function onceOk(fn: () => Promise<string>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RepeatedSubmission) return err.message;
    throw err;
  }
}
const key = (fd: FormData) => str(fd, "idempotencyKey") || null;

/** Balances entered by our office. Every check (permission, last 4, amount, as-of) is in the service. */

const refresh = (clientId?: string) => {
  if (clientId) {
    revalidatePath(`/bookkeeping/${clientId}/banking`);
    revalidatePath(`/clients/${clientId}/portal-preview`);
  }
  revalidatePath("/bookkeeping/balances");
  revalidatePath("/bookkeeping/morning-pull");
  revalidatePath("/client");
};

function asOfOf(fd: FormData) {
  const raw = str(fd, "asOf");
  if (!raw) return null;
  const d = dateOrNull(fd, "asOf");
  if (!d) throw new ValidationError("Enter when the balance was shown at the bank.");
  return d;
}

export async function createManualAccountAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const a = await createManualAccount(actor, clientId, { name: str(fd, "name"), institution: str(fd, "institution"), last4: str(fd, "last4"), kind: str(fd, "kind"), signInUrl: str(fd, "signInUrl"), ledgerAccountId: str(fd, "ledgerAccountId") || null });
    refresh(clientId);
    return `Added ${a.name}${a.last4 ? ` ••${a.last4}` : ""}. Enter its balance below.`;
  });
}

export async function enterManualBalanceAction(clientId: string, accountId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(() => onceOk(async () => {
    await enterManualBalance(actor, clientId, { accountId, amount: str(fd, "amount"), asOf: asOfOf(fd), note: str(fd, "note"), correctsId: str(fd, "correctsId") || null }, new Date(), { idempotencyKey: key(fd) });
    refresh(clientId);
    return str(fd, "correctsId") ? "Correction saved. The earlier entry stays in the history." : "Balance saved. The client's dashboard shows it now.";
  }));
}

export async function archiveManualAccountAction(clientId: string, accountId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await archiveManualAccount(actor, clientId, accountId);
    refresh(clientId);
    return "Archived. It no longer counts toward the client's bank balance; its history is kept.";
  });
}

/** The firm-wide page: fields named amount:<clientId>:<accountId>; blank ones are skipped. */
export async function enterTodaysBalancesAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(() => onceOk(async () => {
    const asOf = asOfOf(fd);
    const entries = [...fd.entries()]
      .filter(([k, v]) => k.startsWith("amount:") && typeof v === "string" && v.trim())
      .map(([k, v]) => {
        const [, clientId, accountId] = k.split(":");
        return { clientId, accountId, amount: String(v), asOf };
      });
    const rows = await enterManualBalances(actor, entries, new Date(), { idempotencyKey: key(fd) });
    for (const c of new Set(entries.map((e) => e.clientId))) refresh(c);
    return `Saved ${rows.length} balance${rows.length === 1 ? "" : "s"}.`;
  }));
}

export async function updateManualAccountLinksAction(clientId: string, accountId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await updateManualAccountLinks(actor, clientId, accountId, { signInUrl: str(fd, "signInUrl"), balanceSource: str(fd, "balanceSource") || null, ...(fd.has("ledgerAccountId") ? { ledgerAccountId: str(fd, "ledgerAccountId") || null } : {}) });
    refresh(clientId);
    return "Saved.";
  });
}

/** Morning bank pull → "Import yesterday's CSV": the Books page's import (same checks and de-duplication). */
export async function morningImportAction(clientId: string, manualAccountId: string | null, ledgerAccountId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(() => onceOk(async () => {
    const f = fd.get("file");
    if (!(f instanceof File) || f.size === 0) throw new ValidationError("Choose the bank's CSV file.");
    if (f.size > 5_000_000) throw new ValidationError("That file is too large. Import one statement at a time.");
    const r = await morningImport(actor, clientId, { manualAccountId, ledgerAccountId: ledgerAccountId ?? (str(fd, "ledgerAccountId") || null), fileName: f.name, text: await f.text() }, new Date(), { idempotencyKey: key(fd) });
    refresh(clientId);
    revalidatePath(`/bookkeeping/${clientId}/books`);
    const b = r.balance;
    const bal = !b ? "" : b.status === "RECORDED" ? ` Balance ${usd(b.balanceCents)} as of ${fmtChicago(b.asOf, { month: "short", day: "numeric", year: "numeric" })} recorded.` : b.status === "DUPLICATE" ? " Balance already recorded." : "reason" in b ? ` ${b.reason}` : "";
    return `Imported ${r.added} new row${r.added === 1 ? "" : "s"}${r.duplicates ? ` (+${r.duplicates} already imported)` : ""}.${r.problems.length ? ` ${r.problems.length} row(s) couldn't be read.` : ""}${bal}`;
  }));
}

/** Morning bank pull → "File statement": a staff-only statement PDF filed under the client, account and period. */
export async function fileStatementAction(clientId: string, manualAccountId: string | null, ledgerAccountId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(() => onceOk(async () => {
    const f = fd.get("statement");
    if (!(f instanceof File) || f.size === 0) throw new ValidationError("Choose the statement PDF.");
    const r = await fileStatement(actor, clientId, { manualAccountId, ledgerAccountId, periodKind: str(fd, "periodKind") || "MONTH", month: str(fd, "month"), bytes: new Uint8Array(await f.arrayBuffer()), originalName: f.name }, { idempotencyKey: key(fd) });
    refresh(clientId);
    revalidatePath(`/clients/${clientId}/documents`);
    if (r.status === "ALREADY_ON_FILE") return "This statement is already on file for that account and period.";
    const read = await readAfterUpload(actor, clientId, r.id);
    revalidatePath(`/bookkeeping/${clientId}/banking/reconciliation`);
    revalidatePath(`/bookkeeping/${clientId}/books`);
    return `${r.document.scanStatus === "CLEAN" ? "Statement filed in the client's Document Vault (staff only)." : "Statement filed (staff only). It counts as on file once the malware scan passes."}${read ? ` ${read}` : ""}`;
  }));
}
