"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { confirmProposedLink, createAndLinkBusiness, grantOwnerPortalAccess, linkBusiness, unlinkBusiness } from "@/lib/services/related-businesses";

const refresh = () => {
  revalidatePath("/clients", "layout");
  revalidatePath("/bookkeeping", "layout");
};

export async function linkExistingBusinessAction(personId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await linkBusiness(actor, personId, str(fd, "businessId"), str(fd, "role") || "OWNER");
    refresh();
    return "Business linked. It keeps its own records; portal access is granted separately.";
  });
}

export async function createLinkedBusinessAction(personId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const b = await createAndLinkBusiness(actor, personId, { businessName: str(fd, "businessName"), clientType: str(fd, "clientType") === "NONPROFIT" ? "NONPROFIT" : "BUSINESS", email: str(fd, "email"), phone: str(fd, "phone"), role: str(fd, "role") || "OWNER" });
    refresh();
    return { ok: `${b.displayName} created and linked. It has its own records, billing and staff.`, next: { href: `/clients/${b.id}`, label: `Open ${b.displayName}` } };
  });
}

export async function grantOwnerAccessAction(personId: string, businessId: string, portalUserId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await grantOwnerPortalAccess(actor, personId, businessId, portalUserId);
    refresh();
    return "Portal access granted for this business only.";
  });
}

export async function confirmLinkAction(personId: string, businessId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await confirmProposedLink(actor, personId, businessId);
    refresh();
    return "Link confirmed.";
  });
}

export async function unlinkBusinessAction(personId: string, businessId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await unlinkBusiness(actor, personId, businessId, str(fd, "reason"));
    refresh();
    revalidatePath("/settings/linked-records");
    return "Link removed. Both clients' records are unchanged, and the removed link is saved in the activity log.";
  });
}
