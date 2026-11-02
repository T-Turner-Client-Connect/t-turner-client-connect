import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { baseFor, explainSquareError, squareProbe, squareSettings } from "@/lib/square";
import { canManageBilling } from "./bookkeeping-profile";

/**
 * A live, read-only check of the Square connection. Having the Netlify variables
 * set ("configured") is not the same as Square accepting them, so this asks Square
 * directly, one read per permission Client Connect needs. It never creates,
 * changes or charges anything, and never shows or stores the token.
 */
export type HealthStep = { key: string; label: string; ok: boolean; warn?: boolean; status?: number; code?: string; detail: string };

const PERMISSION: Record<string, string> = {
  location: "MERCHANT_PROFILE_READ",
  customers: "CUSTOMERS_READ",
  invoices: "INVOICES_READ",
  cards: "PAYMENTS_READ",
  orders: "ORDERS_READ",
};

export async function runSquareHealthCheck(actor: Actor) {
  if (!(await canManageBilling(actor))) throw new ForbiddenError("Only Tabitha (or staff she allows) can check the Square connection.");
  const s = squareSettings();
  const steps: HealthStep[] = [];
  const push = (st: HealthStep) => (steps.push(st), st);

  // 1. Settings (no secrets shown).
  const missing = [!s.locationId && "SQUARE_LOCATION_ID", !s.applicationId && "SQUARE_APPLICATION_ID", !process.env.SQUARE_ACCESS_TOKEN?.trim() && "SQUARE_ACCESS_TOKEN"].filter(Boolean);
  const appIdEnv = s.applicationId.startsWith("sandbox-") ? "sandbox" : s.applicationId.startsWith("sq0idp-") ? "production" : null;
  const notes = [
    s.envVariable === "missing" ? "SQUARE_ENVIRONMENT isn't set, so Client Connect is using Square's SANDBOX (test) server" : s.envVariable === "unrecognized" ? `SQUARE_ENVIRONMENT isn't "production" or "sandbox", so Client Connect is using Square's SANDBOX (test) server` : `SQUARE_ENVIRONMENT = ${s.env}`,
    appIdEnv && appIdEnv !== s.env ? `the Application ID is a ${appIdEnv} ID, but Client Connect is calling Square ${s.env}` : null,
    s.tokenCleanup.length ? `the saved token had ${s.tokenCleanup.join(" and ")} (ignored automatically; worth cleaning up in Netlify)` : null,
  ].filter(Boolean) as string[];
  push({
    key: "settings",
    label: "Netlify settings",
    ok: missing.length === 0 && !(appIdEnv && appIdEnv !== s.env),
    warn: s.envVariable !== "ok" || s.tokenCleanup.length > 0,
    detail: missing.length ? `Missing: ${missing.join(", ")}.` : `Calling Square ${s.env.toUpperCase()}. ${notes.join("; ")}.`,
  });
  if (missing.length) return save(actor, s.env, steps, `Not set up: ${missing.join(", ")} missing in Netlify.`);

  // 2. Token accepted + location (MERCHANT_PROFILE_READ).
  const loc = await squareProbe("GET", `/v2/locations/${encodeURIComponent(s.locationId)}`);
  if (loc.status === 401) {
    // Read-only probe of the other Square environment, to tell a wrong environment from a bad token.
    const other: "production" | "sandbox" = s.env === "production" ? "sandbox" : "production";
    const probe = s.apiBase === baseFor(s.env) ? await squareProbe("GET", "/v2/locations", undefined, baseFor(other)) : null;
    const hint = !probe
      ? "The other Square environment wasn't tested from here."
      : probe.ok
      ? `The same token IS accepted by Square ${other.toUpperCase()}. The token is a ${other} token, so SQUARE_ENVIRONMENT should be "${other}"${other === "sandbox" ? " — or, for real billing, use the production access token instead" : ""}.`
      : `Square ${other} doesn't accept it either, so the token itself isn't valid (pasted incorrectly, replaced, or revoked in the Square Developer Dashboard).`;
    push({ key: "token", label: "Square accepts the access token", ok: false, status: 401, code: loc.code, detail: `${explainSquareError(401, loc.code, loc.detail)} ${hint}` });
    return save(actor, s.env, steps, probe?.ok ? `Square refused the token: it's a ${other} token but Client Connect is calling ${s.env}.` : "Square refused the access token (401). It needs to be checked in the Square Developer Dashboard.");
  }
  push({ key: "token", label: "Square accepts the access token", ok: loc.status !== 0, status: loc.status, code: loc.code, detail: loc.status === 0 ? "Square couldn't be reached." : "Accepted." });
  if (loc.status === 0) return save(actor, s.env, steps, "Square couldn't be reached.");
  if (loc.ok) {
    const l = (loc.json as { location?: { name?: string; business_name?: string; status?: string } }).location;
    push({ key: "location", label: `Location (${PERMISSION.location})`, ok: l?.status === "ACTIVE", status: loc.status, detail: `${s.locationId} — ${l?.business_name ?? ""}${l?.name ? ` (${l.name})` : ""} — ${l?.status ?? "unknown"}${l?.status === "ACTIVE" ? "" : ". Use an ACTIVE location."}` });
  } else if (loc.status === 404) {
    const all = await squareProbe("GET", "/v2/locations");
    const active = ((all.json as { locations?: { id: string; name?: string; status?: string }[] }).locations ?? []).filter((x) => x.status === "ACTIVE").map((x) => `${x.id} (${x.name ?? ""})`);
    push({ key: "location", label: `Location (${PERMISSION.location})`, ok: false, status: 404, code: loc.code, detail: `SQUARE_LOCATION_ID “${s.locationId}” isn't a location on this Square account.${active.length ? ` Active locations: ${active.join(", ")}.` : ""}` });
  } else {
    push({ key: "location", label: `Location (${PERMISSION.location})`, ok: false, status: loc.status, code: loc.code, detail: explainSquareError(loc.status, loc.code, loc.detail) });
  }

  // 3–5. One read per permission.
  const reads: [string, string, () => ReturnType<typeof squareProbe>, boolean][] = [
    ["customers", "Read customers", () => squareProbe("GET", "/v2/customers?limit=1"), true],
    ["invoices", "Read invoices", () => squareProbe("POST", "/v2/invoices/search", { query: { filter: { location_ids: [s.locationId] } }, limit: 1 }), true],
    ["cards", "Read cards on file (display only)", () => squareProbe("GET", "/v2/cards?limit=1"), false],
    ["orders", "Read paid dates and receipts", () => squareProbe("POST", "/v2/orders/search", { location_ids: [s.locationId], limit: 1 }), false],
  ];
  for (const [key, label, run, required] of reads) {
    const r = await run();
    push({ key, label: `${label} (${PERMISSION[key]})`, ok: r.ok || !required, warn: !r.ok && !required, status: r.status, code: r.code, detail: r.ok ? "Allowed." : explainSquareError(r.status, r.code, r.detail) });
  }
  const failed = steps.filter((x) => !x.ok);
  return save(actor, s.env, steps, failed.length ? `Not working: ${failed.map((f) => f.label).join(", ")}.` : `Working: Square ${s.env} accepted the token and every read Client Connect needs.`);
}

async function save(actor: Actor, environment: string, steps: HealthStep[], summary: string) {
  const ok = steps.every((x) => x.ok);
  const row = await prisma.squareHealthCheck.create({ data: { ok, environment, summary, steps, checkedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "square.health_checked", entityType: "Square", entityId: row.id, details: { ok, environment, summary } });
  return row;
}

/** What the app shows instead of a bare "Connected": the last live check, if any. */
export async function squareHealth() {
  const s = squareSettings();
  const last = await prisma.squareHealthCheck.findFirst({ orderBy: { checkedAt: "desc" } });
  const state = !s.configured ? "NOT_CONFIGURED" : !last ? "UNCHECKED" : last.environment !== s.env ? "UNCHECKED" : last.ok ? "WORKING" : "FAILING";
  return { state: state as "NOT_CONFIGURED" | "UNCHECKED" | "WORKING" | "FAILING", last, env: s.env };
}

/** Records a Square authorization failure seen during normal use, so the badge stops saying it works. */
export async function noteSquareAuthFailure(status: number | undefined, code: string | undefined) {
  if (status !== 401 && status !== 403) return;
  const s = squareSettings();
  await prisma.squareHealthCheck.create({
    data: { ok: false, environment: s.env, summary: `Square refused a request (${status}${code ? ` ${code}` : ""}). Run “Check Square connection” for details.`, steps: [{ key: "live", label: "Live request", ok: false, status, code, detail: explainSquareError(status, code, undefined) }] },
  });
}
