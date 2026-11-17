import { cookies } from "next/headers";
import { getPortalUser } from "@/lib/portal/session";
import { requestVisibleWhere, requireClientAccess } from "@/lib/portal/access";
import { prisma } from "@/lib/prisma";

const NEXT_COOKIE = "cc_next";

/**
 * The link in a "we have a question for you" email: opens that exact question in the portal.
 * Not signed in yet → remembered for 30 minutes and returned to after sign-in (and the code step).
 * The email itself never contains the question, an account or a document.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const here = `/client/go/request/${encodeURIComponent(id)}`;
  const jar = await cookies();
  const user = await getPortalUser();
  const to = (path: string) => Response.redirect(new URL(path, req.url), 303);
  if (!user) {
    jar.set(NEXT_COOKIE, here, { httpOnly: true, secure: true, sameSite: "lax", path: "/client", maxAge: 30 * 60 });
    return to("/client/login");
  }
  jar.delete({ name: NEXT_COOKIE, path: "/client" });
  const r = await prisma.documentRequest.findFirst({ where: { id, AND: [requestVisibleWhere(user.id)] }, select: { id: true, clientId: true, category: true } });
  if (!r) return to("/client");
  try { await requireClientAccess(user.id, r.clientId); } catch { return to("/client"); }
  const page = r.category === "TAXES" ? "taxes" : "bookkeeping";
  return to(`/client/${page}?account=${encodeURIComponent(r.clientId)}#request-${r.id}`);
}
