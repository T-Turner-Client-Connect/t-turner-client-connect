"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import {
  confirmAcceptance,
  confirmAcceptances,
  deliverAcceptedReturn,
  deliverIntake,
  relabelFilingDocument,
  removeFilingDocument,
  convertToReturnCopy,
  editFilingDetails,
  moveFilingDocument,
  removeFiling,
  withdrawAcceptanceRequest,
  type AcceptedFilingInput,
  type FilingDocType,
} from "@/lib/services/accepted-returns";
import { discardIntake } from "@/lib/services/tax-returns";
import { deliveryFrom, fileIn, ownerFrom, summarize } from "@/lib/tax/delivery-form";

const refresh = () => {
  revalidatePath("/taxes/returns");
  revalidatePath("/clients", "layout");
  revalidatePath("/owner", "layout");
};

export async function deliverAcceptedReturnAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    // "Finish & Send": for Tabitha, marking Accepted and sending to the client are one step.
    const r = await deliverAcceptedReturn(actor, { ...(await deliveryFrom(fd, clientId, await fileIn(fd, "file"))), sendToClient: true });
    refresh();
    return summarize(r, Number(str(fd, "taxYear")));
  });
}

export async function confirmAcceptanceAction(filingId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await confirmAcceptance(actor, filingId, ownerFrom(fd));
    refresh();
    return "Confirmed: recorded as submitted and accepted. Use “Send to client” to deliver the return.";
  });
}

export async function confirmAcceptancesAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const withdraw = str(fd, "withdraw");
    if (withdraw) {
      await withdrawAcceptanceRequest(actor, withdraw, str(fd, `${withdraw}:reason`) || "Withdrawn from the queue");
      refresh();
      return "Withdrawn. The return stays a staff-only draft.";
    }
    const only = str(fd, "only");
    const ids = only ? [only] : fd.getAll("filingId").filter((v): v is string => typeof v === "string");
    if (!ids.length) throw new ValidationError("Tick the returns to confirm.");
    const r = await confirmAcceptances(actor, ids, ownerFrom(fd));
    refresh();
    return `${r.done.length} confirmed as accepted${r.skipped.length ? `; ${r.skipped.length} not confirmed (${r.skipped.map((x) => x.reason).join("; ")})` : ""}.`;
  });
}

export async function withdrawAcceptanceAction(filingId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await withdrawAcceptanceRequest(actor, filingId, str(fd, "reason"));
    refresh();
    return "Withdrawn. The return stays a staff-only draft.";
  });
}

export async function relabelFilingDocAction(documentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await relabelFilingDocument(actor, documentId, str(fd, "to") as FilingDocType);
    refresh();
    return "Re-labeled (audited).";
  });
}

export async function removeFilingDocAction(documentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await removeFilingDocument(actor, documentId, str(fd, "reason"));
    refresh();
    return "Removed from the filing (kept in the audit trail).";
  });
}

/**
 * Bulk page: one form for the whole review queue. Each row carries its client,
 * year, return and accepted date (plus an optional state). "Deliver" on a row
 * does that row; "Deliver all rows with an accepted date" does every filled row.
 */
export async function bulkDeliverAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const discard = str(fd, "discard");
    if (discard) {
      await discardIntake(actor, discard, str(fd, `${discard}:reason`));
      refresh();
      return "Removed from the queue.";
    }
    const only = str(fd, "only");
    const ids = only ? [only] : fd.getAll("row").filter((v): v is string => typeof v === "string").filter((id) => str(fd, `${id}:fed.acceptedOn`) || str(fd, `${id}:acceptedOn`));
    if (!ids.length) throw new ValidationError("Enter an “Accepted on” date for the rows to deliver.");
    const done: string[] = [];
    const failed: string[] = [];
    let waiting = 0;
    for (const id of ids) {
      const p = `${id}:`;
      const filings: AcceptedFilingInput[] = [];
      const jurisdiction = str(fd, `${p}jurisdiction`);
      if (jurisdiction) filings.push({ jurisdiction, returnType: str(fd, `${p}returnType`), acceptedOn: str(fd, `${p}acceptedOn`) || null, submissionId: str(fd, `${p}submissionId`) || null });
      const state = str(fd, `${p}stateCode`);
      if (state) filings.push({ jurisdiction: state, returnType: str(fd, `${p}stateReturnType`), acceptedOn: str(fd, `${p}stateAcceptedOn`) || str(fd, `${p}acceptedOn`) || null, submissionId: str(fd, `${p}stateSubmissionId`) || null });
      const name = str(fd, `${p}name`) || "a return";
      try {
        const r = await deliverIntake(actor, id, {
          clientId: str(fd, `${p}clientId`),
          taxYear: Number(str(fd, `${p}taxYear`)),
          filingType: str(fd, `${p}filingType`) === "AMENDED" ? "AMENDED" : "ORIGINAL",
          filings,
          verificationNote: str(fd, "verificationNote"),
          owner: ownerFrom(fd),
          relabelAck: fd.get("relabelAck") === "on",
          sendToClient: fd.get("sendToClient") === "on",
          notifyClient: fd.get("notifyClient") === "on",
          closeDraftSummary: fd.get("closeDraftSummary") === "on",
        });
        waiting += r.results.filter((x) => x.outcome === "awaiting_owner").length;
        done.push(name);
      } catch (e) {
        if (!(e instanceof ValidationError) && !(e instanceof Error && e.name === "ForbiddenError")) throw e;
        failed.push(`${name}: ${e.message}`);
      }
    }
    refresh();
    if (!done.length) throw new ValidationError(`Nothing was delivered. ${failed.join(" · ")}`);
    return `${done.length} delivered${waiting ? ` (${waiting} return${waiting === 1 ? "" : "s"} waiting for Tabitha to confirm acceptance)` : ""}${failed.length ? `. Not delivered: ${failed.join(" · ")}` : ""}.`;
  });
}

/** "This is the return, not the acknowledgment" / "Use this file as the return copy". */
export async function convertToReturnCopyAction(documentId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const d = await convertToReturnCopy(actor, documentId);
    refresh();
    revalidatePath("/documents");
    return d.visibility === "PUBLISHED" ? `Now the return copy “${d.title}” — in the client's vault (shown once the malware scan passes).` : `Now the return copy “${d.title}” (staff only until released).`;
  });
}

export async function editFilingDetailsAction(filingId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const t = str(fd, "filingType");
    await editFilingDetails(actor, filingId, { taxYear: Number(str(fd, "taxYear")), returnType: str(fd, "returnType"), jurisdiction: str(fd, "jurisdiction"), filingType: t === "AMENDED" || t === "EXTENSION" ? t : "ORIGINAL" }, str(fd, "reason"));
    refresh();
    return "Filing details corrected (recorded in the status history).";
  });
}

export async function removeFilingAction(filingId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await removeFiling(actor, filingId, str(fd, "reason"));
    refresh();
    return "Filing removed. Its full history is kept in the audit log; its documents stay in the client's file.";
  });
}

export async function moveFilingDocAction(documentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await moveFilingDocument(actor, documentId, str(fd, "filingId"));
    refresh();
    return "Moved to the other filing (audited).";
  });
}
