"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { addBusinessLicense, archiveBusinessLicense, setPayrollPayDate, setYearEndStage, updateLicenseRenewal } from "@/lib/services/business-overview";

const refresh = () => revalidatePath("/bookkeeping", "layout");

export async function addLicenseAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await addBusinessLicense(actor, clientId, { name: str(fd, "name"), jurisdiction: str(fd, "jurisdiction"), licenseNumber: str(fd, "licenseNumber"), renewalDate: str(fd, "renewalDate"), note: str(fd, "note") });
    refresh();
    return "License added.";
  });
}

export async function renewLicenseAction(licenseId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await updateLicenseRenewal(actor, licenseId, str(fd, "renewalDate"));
    refresh();
    return "Renewal date saved.";
  });
}

export async function removeLicenseAction(licenseId: string, _prev: ActionState, _fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await archiveBusinessLicense(actor, licenseId);
    refresh();
    return "License removed (kept in the history).";
  });
}

export async function yearEndStageAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setYearEndStage(actor, clientId, Number(str(fd, "taxYear")), str(fd, "stage"), str(fd, "note"));
    refresh();
    return "Saved.";
  });
}

export async function payDateAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setPayrollPayDate(actor, clientId, str(fd, "payDate") || null);
    refresh();
    return "Pay date saved.";
  });
}
