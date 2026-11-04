import "server-only";
import type { EmployeeLine, Amounts } from "./register";

/**
 * Direct payroll-provider connections (ADP, Paychex). DISABLED until the firm's partner
 * approval and production credentials exist — see docs/payroll-integrations.md.
 *
 * Nothing here calls ADP or Paychex today. `status()` only reports whether credentials are
 * present; `fetchPayRuns()` refuses until a verified implementation is added. When a provider
 * is approved, fetched pay runs go through the same path as an imported register
 * (createRunsFromPayDates in services/payroll.ts): DRAFT runs and DRAFT journal entries for
 * the office's review — never posted, approved or released automatically.
 *
 * Environment variables (set in Netlify → Site configuration → Environment variables):
 *   ADP:     ADP_CLIENT_ID, ADP_CLIENT_SECRET (OAuth client credentials from ADP),
 *            ADP_CERT, ADP_KEY (PEM text of the mutual-TLS certificate ADP signs, and its private key)
 *   Paychex: PAYCHEX_CLIENT_ID, PAYCHEX_CLIENT_SECRET (API key/secret Paychex issues to an approved partner)
 */

export type ProviderKey = "ADP" | "PAYCHEX";
export type ProviderPayRun = Amounts & { checkDate: string; periodStart: string | null; periodEnd: string | null; employees: number; lines: EmployeeLine[]; externalId: string };

export interface PayrollProvider {
  key: ProviderKey;
  label: string;
  /** Env vars that must be set before anything can connect. */
  requiredEnv: string[];
  /** What the firm must obtain first (shown in the UI). */
  requirement: string;
  configured(): boolean;
  /** Pay runs with a check date in [from, to] for one connected company. */
  fetchPayRuns(externalCompanyId: string, from: string, to: string): Promise<ProviderPayRun[]>;
}

export class ProviderNotConnectedError extends Error {}

const has = (names: string[]) => names.every((n) => !!process.env[n]?.trim());

export const adpProvider: PayrollProvider = {
  key: "ADP",
  label: "ADP",
  requiredEnv: ["ADP_CLIENT_ID", "ADP_CLIENT_SECRET", "ADP_CERT", "ADP_KEY"],
  requirement: "ADP Marketplace partner approval (data connector), production OAuth credentials and an ADP-signed mutual-TLS certificate",
  configured() {
    return has(this.requiredEnv);
  },
  async fetchPayRuns() {
    // TODO(ADP, after partner approval): implement with the endpoints, scopes and consent flow in
    // ADP's partner documentation for the approved connector (token from accounts.adp.com with
    // client credentials over mutual TLS, then the payroll output / pay statements APIs per worker).
    // Deliberately not implemented: the exact endpoints and RUN coverage can't be verified until ADP
    // approves the application and grants documentation access.
    throw new ProviderNotConnectedError("Not connected — requires ADP partner approval (see setup guide).");
  },
};

export const paychexProvider: PayrollProvider = {
  key: "PAYCHEX",
  label: "Paychex",
  requiredEnv: ["PAYCHEX_CLIENT_ID", "PAYCHEX_CLIENT_SECRET"],
  requirement: "Paychex Integrated Partner approval and production API credentials",
  configured() {
    return has(this.requiredEnv);
  },
  async fetchPayRuns() {
    // TODO(Paychex, after partner approval): implement with Paychex's documented partner APIs
    // (OAuth client-credentials token, company lookup by the client's displayId after the client
    // approves the app in Paychex Flex, then the company's payroll checks for the date range).
    // Deliberately not implemented until production access and documentation are granted.
    throw new ProviderNotConnectedError("Not connected — requires Paychex partner approval (see setup guide).");
  },
};

/** The API provider for a payroll system, if one exists. */
export function providerFor(system: string | null | undefined): PayrollProvider | null {
  if (system === "ADP_RUN" || system === "ADP_WFN") return adpProvider;
  if (system === "PAYCHEX_FLEX") return paychexProvider;
  return null;
}

/** What the Payroll page shows about the direct connection. Reads env presence only, never values. */
export function connectionStatus(system: string | null | undefined, connection: { status: string } | null) {
  const p = providerFor(system);
  if (!p) return { available: false as const, label: "No direct connection for this payroll system — use the register import." };
  if (!p.configured()) return { available: false as const, provider: p.label, label: `Not connected — requires ${p.label} partner approval (see setup guide).` };
  if (!connection || connection.status !== "CONNECTED") return { available: false as const, provider: p.label, label: `${p.label} credentials are set, but this business hasn't authorized the connection yet.` };
  return { available: true as const, provider: p.label, label: `Connected to ${p.label}.` };
}
