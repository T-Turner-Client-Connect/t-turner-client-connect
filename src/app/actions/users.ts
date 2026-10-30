"use server";

import { revalidatePath } from "next/cache";
import type { Role } from "@prisma/client";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { createPasswordReset, updateStaff } from "@/lib/services/users";
import { createPrivateInviteLink, inviteStaff, resendInvite, revokeInvite, type InviteOutcome } from "@/lib/services/staff-invitations";
import { ValidationError } from "@/lib/services/clients";
import { appUrl } from "@/lib/integrations";
import { prisma } from "@/lib/prisma";

// The private link (when email didn't go out) is returned only to the Admin
// who asked; it's never stored in readable form or logged.
async function inviteResult(fn: () => Promise<InviteOutcome>): Promise<ActionState> {
  let outcome: InviteOutcome | undefined;
  const state = await run(async () => {
    outcome = await fn();
    revalidatePath("/settings");
    return outcome.message;
  });
  return outcome?.privateLink && state?.ok ? { ...state, link: outcome.privateLink } : state;
}

export async function inviteAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  const role = str(fd, "role") === "ADMIN" ? "ADMIN" : "STAFF";
  const grants = { identityAll: fd.get("grantIdentityAccessAll") === "on", billing: fd.get("grantBillingAccess") === "on" };
  return inviteResult(() => inviteStaff(actor, { email: str(fd, "email"), name: str(fd, "name"), role, grants, idempotencyKey: str(fd, "idempotencyKey") || undefined }));
}

export async function resendInviteAction(inviteId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return inviteResult(() => resendInvite(actor, inviteId));
}

export async function privateInviteLinkAction(inviteId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return inviteResult(() => createPrivateInviteLink(actor, inviteId));
}

export async function revokeInviteAction(inviteId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await revokeInvite(actor, inviteId);
    revalidatePath("/settings");
    return "Invitation revoked. Its link no longer works.";
  });
}

export async function resetLinkAction(userId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new ValidationError("Staff member not found.");
    const reset = await createPasswordReset(user.email, actor);
    if (!reset) throw new ValidationError("That account is inactive.");
    return `One-time reset link (valid 1 hour): ${appUrl()}/staff/reset-password/${reset.token}`;
  });
}

export async function updateStaffAction(userId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const role = str(fd, "role") as Role;
    const active = str(fd, "active") === "true";
    await updateStaff(actor, userId, { role: role === "ADMIN" ? "ADMIN" : "STAFF", active });
    revalidatePath("/settings");
    return "Updated.";
  });
}
