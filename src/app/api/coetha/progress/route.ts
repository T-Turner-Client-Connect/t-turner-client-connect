import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/auth/actor";
import { assertLedger } from "@/lib/services/ledger";
import { kickBackgroundReading, workOnce } from "@/lib/services/coetha-reading";
import { prisma } from "@/lib/prisma";

// The open Ask Coetha page checks in every few seconds while Coetha is reading. Each check-in also
// moves this business's reading one unit forward, so reading continues even if the background
// function isn't running. Staff with access to the business's books only.
export const maxDuration = 60;

export async function POST(req: Request) {
  const actor = await getCurrentUser();
  if (!actor) return Response.json({ error: "Sign in again." }, { status: 401 });
  const { clientId } = (await req.json().catch(() => ({}))) as { clientId?: string };
  try {
    await assertLedger(actor, String(clientId ?? ""));
  } catch (err) {
    return Response.json({ error: err instanceof ForbiddenError ? err.message : "Not allowed." }, { status: 403 });
  }
  const r = await workOnce({ clientId: String(clientId) });
  if (r.more) await kickBackgroundReading();
  const jobs = await prisma.coethaDocJob.findMany({ where: { clientId: String(clientId), status: { in: ["QUEUED", "READING"] } }, select: { id: true, pages: true, pagesDone: true } });
  return Response.json({ more: r.more, did: r.did, reading: jobs.length, pagesLeft: jobs.reduce((n, j) => n + Math.max(0, j.pages - j.pagesDone), 0) });
}
