"use server";

import { revalidatePath } from "next/cache";
import type { Role } from "@prisma/client";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { createInvite, createPasswordReset, revokeInvite, updateStaff } from "@/lib/services/users";
import { ValidationError } from "@/lib/services/clients";
import { appUrl } from "@/lib/integrations";
import { prisma } from "@/lib/prisma";

export async function inviteAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const role = str(fd, "role") === "ADMIN" ? "ADMIN" : "STAFF";
    const token = await createInvite(actor, { email: str(fd, "email"), name: str(fd, "name"), role });
    revalidatePath("/settings");
    return `Invitation created. Send this one-time link to them privately (valid 7 days): ${appUrl()}/staff/invite/${token}`;
  });
}

export async function revokeInviteAction(inviteId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await revokeInvite(actor, inviteId);
    revalidatePath("/settings");
    return "Invitation revoked.";
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
