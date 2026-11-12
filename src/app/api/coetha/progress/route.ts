import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/auth/actor";
import { assertLedger } from "@/lib/services/ledger";
import { kickBackgroundReading } from "@/lib/services/coetha-reading";
import { answerStatus, answersWaitingWithoutWorker, kickAnswers } from "@/lib/services/coetha-answer";
import { takeLock } from "@/lib/services/coetha-chat";
import { prisma } from "@/lib/prisma";

// The open Ask Coetha page checks in every few seconds while Coetha is working. The check-in only
// READS the status (it never does Coetha's work itself, so it answers at once); if work is waiting
// that nothing is working on, it starts the background functions (at most every 30 seconds).
// Staff with access to the business's books only.
export async function POST(req: Request) {
  const actor = await getCurrentUser();
  if (!actor) return Response.json({ error: "Sign in again." }, { status: 401 });
  const { clientId } = (await req.json().catch(() => ({}))) as { clientId?: string };
  try {
    await assertLedger(actor, String(clientId ?? ""));
  } catch (err) {
    return Response.json({ error: err instanceof ForbiddenError ? err.message : "Not allowed." }, { status: 403 });
  }
  const id = String(clientId);
  const jobs = await prisma.coethaDocJob.findMany({ where: { clientId: id, status: { in: ["QUEUED", "READING"] } }, select: { id: true, pages: true, pagesDone: true } });
  if ((jobs.length || (await answersWaitingWithoutWorker())) && (await takeLock("coetha-kick", 30))) {
    if (jobs.length) await kickBackgroundReading();
    await kickAnswers();
  }
  const answers = await answerStatus(id);
  return Response.json({ reading: jobs.length, pagesLeft: jobs.reduce((n, j) => n + Math.max(0, j.pages - j.pagesDone), 0), answers });
}
