import "server-only";
import { notFound, redirect } from "next/navigation";
import { accessibleClients } from "./access";
import { serviceProfile } from "@/lib/services/service-profile";
import { ForbiddenError } from "@/lib/auth/actor";

/** Resolves the account (client) being viewed from ?account=, defaulting to the first. */
export async function resolveAccount(portalUserId: string, requested?: string) {
  const accounts = await accessibleClients(portalUserId);
  if (accounts.length === 0) return { accounts, current: null };
  const current = requested ? accounts.find((a) => a.clientId === requested) : accounts[0];
  if (!current) notFound();
  return { accounts, current };
}

/**
 * Personal tax pages (questionnaire, My Tax Center, tax summary, identity
 * documents, refund options) don't exist for a business-only client: the page
 * sends them back to the business home instead.
 */
export async function requirePersonalTaxAccount(clientId: string) {
  if ((await serviceProfile(clientId)).businessOnly) redirect(`/client?account=${encodeURIComponent(clientId)}`);
}

/** The same rule for server functions (actions, API routes). */
export async function assertPersonalTaxAccount(clientId: string) {
  if ((await serviceProfile(clientId)).businessOnly) throw new ForbiddenError("This account is set up for business services only. Use “Request personal tax preparation” to add personal tax services.");
}
