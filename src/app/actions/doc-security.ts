"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { deletePermanentlyNow, restoreDeletedDocument } from "@/lib/services/recently-deleted";
import { encryptionDryRun, pauseEncryptionJob, removeEligibleOriginals, runEncryptionBatch, startEncryptionJob, type EncryptionMode } from "@/lib/services/file-encryption";
import { confirmKeyEscrow, runBackupNow, runRestoreVerification, setNightlyBackups } from "@/lib/services/backups";
import { GROUP_LABEL, normalizeGroupOrder } from "@/lib/doc-security/inventory";

// Owner's Office → Recently deleted ------------------------------------------------------------

export async function restoreDocumentAction(documentId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await restoreDeletedDocument(actor, documentId);
    revalidatePath("/owner/recently-deleted");
    return "Restored. The document is back where it was, with the same visibility.";
  });
}

export async function deletePermanentlyAction(documentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await deletePermanentlyNow(actor, documentId, str(fd, "confirm"), str(fd, "reason"));
    revalidatePath("/owner/recently-deleted");
    return "Removed permanently. The record and its audit trail are kept; backups keep a copy only as long as the retention policy keeps those nights.";
  });
}

// Owner's Office → File encryption ---------------------------------------------------------------

const orderFrom = (fd: FormData) => {
  const picked = fd.getAll("order").filter((v): v is string => typeof v === "string" && !!v);
  return picked.length ? normalizeGroupOrder(picked) : null;
};

export async function encryptionDryRunAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const mode = (str(fd, "mode") === "REKEY" ? "REKEY" : "ENCRYPT") as EncryptionMode;
    const r = await encryptionDryRun({ actor }, mode, orderFrom(fd));
    const first = r.groups.slice(0, 3).map((g) => `${GROUP_LABEL[g.group]} ${g.files}`).join(", ");
    return `Dry run: ${r.files} file${r.files === 1 ? "" : "s"} (${(r.bytes / 1048576).toFixed(1)} MB) would be ${mode === "REKEY" ? "re-encrypted" : "encrypted"}${first ? `, first: ${first}` : ""}. Nothing was read or changed.`;
  });
}

export async function startEncryptionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const mode = (str(fd, "mode") === "REKEY" ? "REKEY" : "ENCRYPT") as EncryptionMode;
    await startEncryptionJob({ actor }, mode, orderFrom(fd));
    const r = await runEncryptionBatch({ actor }, { budgetMs: 15_000, limit: 50 });
    revalidatePath("/owner/file-encryption");
    return `Batch done: ${r.migrated} moved, ${r.failed} failed (left untouched, retried next batch), ${r.remaining} still to do.`;
  });
}

export async function runEncryptionBatchAction(_prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await runEncryptionBatch({ actor }, { budgetMs: 15_000, limit: 50 });
    revalidatePath("/owner/file-encryption");
    return `Batch done: ${r.migrated} moved, ${r.failed} failed (left untouched, retried next batch), ${r.remaining} still to do.`;
  });
}

export async function pauseEncryptionAction(jobId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await pauseEncryptionJob({ actor }, jobId);
    revalidatePath("/owner/file-encryption");
    return "Paused. Nothing is lost; start again to resume where it stopped.";
  });
}

export async function removeOriginalsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (str(fd, "confirm").trim() !== "REMOVE ORIGINALS") return { ok: "Type REMOVE ORIGINALS to confirm. Nothing was removed." };
    const r = await removeEligibleOriginals({ actor });
    revalidatePath("/owner/file-encryption");
    return `${r.removed} original${r.removed === 1 ? "" : "s"} removed (each was replaced 30+ days ago and its encrypted copy is in a successful backup).`;
  });
}

// Owner's Office → Backups -------------------------------------------------------------------------

export async function nightlyBackupsAction(on: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setNightlyBackups(actor, on);
    revalidatePath("/owner/backups");
    return `Nightly backups turned ${on ? "on" : "off"}.`;
  });
}

export async function backupNowAction(_prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await runBackupNow(actor);
    revalidatePath("/owner/backups");
    if (r.state === "done") return "Backup finished.";
    if (r.state === "failed") return { ok: `Backup failed: ${r.error ?? "see the run list"}` };
    return "Backup started. The nightly schedule finishes whatever is left within the hour.";
  });
}

export async function restoreVerifyAction(_prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await runRestoreVerification(actor);
    revalidatePath("/owner/backups");
    if (r.test.status === "PASSED") return `Restore check passed: ${r.report?.chunksChecked ?? 0} database chunks and ${r.report?.filesChecked ?? 0} files matched the manifest; ${r.report?.samples.length ?? 0} sample documents opened.`;
    return { ok: `Restore check FAILED: ${r.test.error ?? "see the list below"}` };
  });
}

export async function keyEscrowAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await confirmKeyEscrow(actor, { checked: fd.get("confirmed") === "on", note: str(fd, "note") });
    revalidatePath("/owner/backups");
    return "Key escrow confirmation recorded.";
  });
}
