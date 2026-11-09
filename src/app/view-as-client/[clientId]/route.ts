import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { previewCookieOptions, previewCookieValue, previewLogins, VAC_COOKIE } from "@/lib/portal/viewer";

/**
 * Starts View as Client: staff only. Picks the client's portal login to view as (?as=, default
 * the primary owner login; none → the client's services with owner-level access), sets the
 * signed preview cookie and opens the client's own portal. Read-only: see lib/portal/viewer.ts.
 */
export async function GET(req: Request, ctx: { params: Promise<{ clientId: string }> }) {
  const staff = await requireUser();
  const { clientId } = await ctx.params;
  const url = new URL(req.url);
  const client = await prisma.client.findFirst({ where: { id: clientId, archivedAt: null }, select: { id: true } });
  if (!client) return NextResponse.json({ error: "Client not found." }, { status: 404 });
  const logins = await previewLogins(clientId);
  const asked = url.searchParams.get("as");
  const login = (asked && logins.find((l) => l.id === asked)) || logins[0] || null;
  (await cookies()).set(VAC_COOKIE, previewCookieValue({ staffId: staff.id, clientId, loginId: login?.id ?? null }), previewCookieOptions());
  await audit(prisma, { actorId: staff.id, action: "portal.staff_preview", entityType: "Client", entityId: clientId, clientId, details: { view: "start", loginId: login?.id ?? null } });
  // Only a client portal page may follow (never an outside address).
  const to = url.searchParams.get("to");
  const next = to && /^\/client(\/[\w\-/]*)?$/.test(to) ? to : "/client";
  // A path on the same site, never an absolute address built from the request: behind the host,
  // the request's own URL can name the deploy's internal address, where the staff member isn't signed in.
  return new NextResponse(null, { status: 307, headers: { Location: `${next}?account=${encodeURIComponent(clientId)}` } });
}
