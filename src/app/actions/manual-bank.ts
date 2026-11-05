"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { dateOrNull, run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { archiveManualAccount, createManualAccount, enterManualBalance, enterManualBalances, morningImport, updateManualAccountLinks } from "@/lib/services/manual-bank";
import { usd } from "@/lib/services/ledger";
import { fmtChicago } from "@/lib/tz";

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
  return run(async () => {
    await enterManualBalance(actor, clientId, { accountId, amount: str(fd, "amount"), asOf: asOfOf(fd), note: str(fd, "note"), correctsId: str(fd, "correctsId") || null });
    refresh(clientId);
    return str(fd, "correctsId") ? "Correction saved. The earlier entry stays in the history." : "Balance saved. The client's dashboard shows it now.";
  });
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
  return run(async () => {
    const asOf = asOfOf(fd);
    const entries = [...fd.entries()]
      .filter(([k, v]) => k.startsWith("amount:") && typeof v === "string" && v.trim())
      .map(([k, v]) => {
        const [, clientId, accountId] = k.split(":");
        return { clientId, accountId, amount: String(v), asOf };
      });
    const rows = await enterManualBalances(actor, entries);
    for (const c of new Set(entries.map((e) => e.clientId))) refresh(c);
    return `Saved ${rows.length} balance${rows.length === 1 ? "" : "s"}.`;
  });
}

export async function updateManualAccountLinksAction(clientId: string, accountId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await updateManualAccountLinks(actor, clientId, accountId, { signInUrl: str(fd, "signInUrl"), ...(fd.has("ledgerAccountId") ? { ledgerAccountId: str(fd, "ledgerAccountId") || null } : {}) });
    refresh(clientId);
    return "Saved.";
  });
}

/** Morning bank pull → "Import yesterday's CSV": the Books page's import (same checks and de-duplication). */
export async function morningImportAction(clientId: string, manualAccountId: string | null, ledgerAccountId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const f = fd.get("file");
    if (!(f instanceof File) || f.size === 0) throw new ValidationError("Choose the bank's CSV file.");
    if (f.size > 5_000_000) throw new ValidationError("That file is too large. Import one statement at a time.");
    const r = await morningImport(actor, clientId, { manualAccountId, ledgerAccountId: ledgerAccountId ?? (str(fd, "ledgerAccountId") || null), fileName: f.name, text: await f.text() });
    refresh(clientId);
    revalidatePath(`/bookkeeping/${clientId}/books`);
    const b = r.balance;
    const bal = !b ? "" : b.status === "RECORDED" ? ` Balance ${usd(b.balanceCents)} as of ${fmtChicago(b.asOf, { month: "short", day: "numeric", year: "numeric" })} recorded.` : b.status === "DUPLICATE" ? " Balance already recorded." : "reason" in b ? ` ${b.reason}` : "";
    return `Imported ${r.added} new row${r.added === 1 ? "" : "s"}${r.duplicates ? ` (+${r.duplicates} already imported)` : ""}.${r.problems.length ? ` ${r.problems.length} row(s) couldn't be read.` : ""}${bal}`;
  });
}
