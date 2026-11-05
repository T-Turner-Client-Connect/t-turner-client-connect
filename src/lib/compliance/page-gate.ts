import "server-only";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { complianceAccess } from "@/lib/services/compliance/access";

/** Page gate: no Tax & Compliance access → a plain 404 (the section isn't advertised). */
export async function requireCompliancePage(opts: { owner?: boolean } = {}) {
  const actor = await requireUser();
  const access = await complianceAccess(actor);
  if (access.level === "NONE" || (opts.owner && !access.isOwner)) notFound();
  return { actor, access };
}
