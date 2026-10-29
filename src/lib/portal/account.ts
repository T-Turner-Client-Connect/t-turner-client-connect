import "server-only";
import { notFound } from "next/navigation";
import { accessibleClients } from "./access";

/** Resolves the account (client) being viewed from ?account=, defaulting to the first. */
export async function resolveAccount(portalUserId: string, requested?: string) {
  const accounts = await accessibleClients(portalUserId);
  if (accounts.length === 0) return { accounts, current: null };
  const current = requested ? accounts.find((a) => a.clientId === requested) : accounts[0];
  if (!current) notFound();
  return { accounts, current };
}
