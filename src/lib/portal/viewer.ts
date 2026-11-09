import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { PortalAccess } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sign, verifySignature } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import type { Actor } from "@/lib/auth/actor";
import { can } from "@/lib/auth/permissions";
import { requirePortalUser, type PortalActor } from "@/lib/portal/session";
import { accessibleClients, BUSINESS_VIEW_CLIENT, effectiveGrant } from "@/lib/portal/access";
import { OWNER_PREVIEW_PERMS } from "@/lib/portal/views";
import { downloadToken } from "@/lib/services/documents";
import { previewFormAction } from "@/app/actions/preview";

/**
 * View as Client — the staff member's whole screen becomes the client's own portal (the real
 * /client pages, layout, menu and links), read-only.
 *
 * How it stays read-only, on the server:
 * - Starting a preview sets a short-lived, signed cookie naming the staff member, the client and
 *   the portal login being viewed. It is honoured only together with that same staff member's
 *   live staff session, and only by portal PAGES (portalViewer below). It is never a portal
 *   session: every portal Server Action and /api/client route still requires a real portal
 *   session (requirePortalUser / getPortalUser) and refuses a staff preview.
 * - In a preview, pages pass only the preview stand-in actions (app/actions/preview.ts), which
 *   save, send, sign, book and charge nothing; page views that would record something (marking a
 *   message read, an invoice or agreement viewed) are skipped.
 * - Only the previewed client is shown (the login's other accounts are left out), and every page
 *   view is audited as portal.staff_preview with the page name.
 */

const SECURE = process.env.NODE_ENV === "production";
export const VAC_COOKIE = SECURE ? "__Host-tcc_vac" : "tcc_vac";
// A working day: a View as Client tab left open shouldn't end mid-review.
const PREVIEW_TTL_MS = 10 * 60 * 60 * 1000;

type Payload = { s: string; c: string; l: string | null; e: number };

export function previewCookieValue(p: { staffId: string; clientId: string; loginId: string | null }, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ s: p.staffId, c: p.clientId, l: p.loginId, e: now + PREVIEW_TTL_MS } satisfies Payload)).toString("base64url");
  return `${body}.${sign(`vac:${body}`)}`;
}

export function parsePreviewCookie(value: string | undefined, now = Date.now()): Payload | null {
  if (!value) return null;
  const [body, sig] = value.split(".");
  if (!body || !sig || !verifySignature(`vac:${body}`, sig)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
    return typeof p.s === "string" && typeof p.c === "string" && p.e > now ? p : null;
  } catch {
    return null;
  }
}

export const previewCookieOptions = (now = Date.now()) => ({ httpOnly: true, secure: SECURE, sameSite: "lax" as const, path: "/", expires: new Date(now + PREVIEW_TTL_MS) });

export type Grant = Awaited<ReturnType<typeof accessibleClients>>[number];

/** The portal logins of a client that View as Client can view as (primary owner first). */
export async function previewLogins(clientId: string) {
  const rows = await prisma.portalAccess.findMany({
    where: { clientId, revokedAt: null, portalUser: { active: true } },
    include: { portalUser: { select: { id: true, name: true, email: true, passwordHash: true } } },
    orderBy: [{ createdAt: "asc" }],
  });
  const order = (r: (typeof rows)[number]) => (r.role === "OWNER" ? 0 : 1) + (r.portalUser.passwordHash ? 0 : 2);
  return [...rows].sort((a, b) => order(a) - order(b)).map((r) => ({ id: r.portalUser.id, name: r.portalUser.name, email: r.portalUser.email, role: r.role, signedUp: !!r.portalUser.passwordHash }));
}

/** A live preview: the signed cookie, the same staff member signed in, the client and login valid. */
export const getPreviewSession = cache(async (): Promise<{ staff: Actor; clientId: string; loginId: string | null } | null> => {
  // Outside a request (no cookies to read) there is no preview.
  let raw: string | undefined;
  try {
    raw = (await cookies()).get(VAC_COOKIE)?.value;
  } catch {
    return null;
  }
  const p = parsePreviewCookie(raw);
  if (!p) return null;
  const staff = await getCurrentUser();
  if (!staff || staff.id !== p.s) return null;
  const client = await prisma.client.findFirst({ where: { id: p.c, archivedAt: null }, select: { id: true } });
  if (!client) return null;
  if (p.l) {
    const ok = await prisma.portalAccess.count({ where: { clientId: p.c, portalUserId: p.l, revokedAt: null, portalUser: { active: true } } });
    if (!ok) return null;
  }
  return { staff, clientId: p.c, loginId: p.l };
});

type FormState = { error?: string; ok?: string; at?: number } | null;

export type PortalViewerBase = {
  /** The portal login being viewed: the signed-in client, or (preview) the login staff chose. Null: a preview of a client with no portal login. */
  user: PortalActor | null;
  accounts: Grant[];
  preview: { staff: Actor; clientId: string; loginId: string | null } | null;
};

/** No portal login: the client's own services with owner-level flags (business view by the portal's own rule). */
async function ownerLevelGrant(clientId: string): Promise<Grant> {
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { id: true, displayName: true, businessName: true, clientType: true, ...BUSINESS_VIEW_CLIENT } });
  const grant = { id: `preview-${clientId}`, portalUserId: "", clientId, role: "OWNER", ...OWNER_PREVIEW_PERMS, canViewBookkeeping: false, createdAt: new Date(0), revokedAt: null, client } as unknown as PortalAccess & { client: typeof client };
  return effectiveGrant(grant, client) as unknown as Grant;
}

/** Who the portal pages are showing, for the layout and every page (cached per request). */
export const portalViewerBase = cache(async (): Promise<PortalViewerBase> => {
  const preview = await getPreviewSession();
  if (preview) {
    // Staff permissions still apply: billing shows only to staff who may see billing.
    const staffBilling = await can(preview.staff, "billing", "view");
    const limit = (g: Grant): Grant => (staffBilling ? g : { ...g, canViewBilling: false });
    if (preview.loginId) {
      const u = await prisma.portalUser.findUniqueOrThrow({ where: { id: preview.loginId }, select: { id: true, name: true, email: true } });
      // The login's grant for this client only — never its other accounts.
      const grant = (await accessibleClients(u.id)).find((a) => a.clientId === preview.clientId);
      if (!grant) notFound();
      return { user: u, accounts: [limit(grant)], preview };
    }
    return { user: null, accounts: [limit(await ownerLevelGrant(preview.clientId))], preview };
  }
  const user = await requirePortalUser();
  return { user, accounts: await accessibleClients(user.id), preview: null };
});

export type PortalViewer = PortalViewerBase & {
  current: Grant | null;
  /** True in View as Client: forms render disabled and post only to the preview stand-ins. */
  readOnly: boolean;
  /** A document link for whoever is looking (a staff link in the preview). */
  linkFor: (documentId: string) => string;
  /** The portal's own action bound to its arguments, or (preview) the stand-in that saves nothing. */
  act: <S>(fn: (...args: never[]) => Promise<S>, ...args: unknown[]) => (prev: S, fd: FormData) => Promise<S>;
};

/**
 * The start of every portal page: the signed-in client (or the View as Client preview), the
 * account in view (`requested` = ?account=), and the helpers that keep a preview read-only.
 * A preview page view is audited with the page name.
 */
export async function portalViewer(page: string, requested?: string): Promise<PortalViewer> {
  const base = await portalViewerBase();
  const current = base.accounts.length === 0 ? null : requested ? (base.accounts.find((a) => a.clientId === requested) ?? notFound()) : base.accounts[0];
  if (base.preview) {
    await audit(prisma, { actorId: base.preview.staff.id, action: "portal.staff_preview", entityType: "Client", entityId: base.preview.clientId, clientId: base.preview.clientId, details: { view: page, loginId: base.preview.loginId } });
  }
  const staffId = base.preview?.staff.id;
  const portalUserId = base.user?.id;
  return {
    ...base,
    current,
    readOnly: !!base.preview,
    linkFor: (id) => `/api/documents/${downloadToken(id, staffId ? { staffId } : { portalUserId })}`,
    act: <S>(fn: (...args: never[]) => Promise<S>, ...args: unknown[]) =>
      (base.preview ? previewFormAction : (fn as (...a: unknown[]) => unknown).bind(null, ...args)) as unknown as (prev: S, fd: FormData) => Promise<S>,
  };
}

export type { FormState };
