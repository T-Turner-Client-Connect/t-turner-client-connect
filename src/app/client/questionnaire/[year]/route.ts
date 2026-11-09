import { requirePortalUser } from "@/lib/portal/session";
import { getPreviewSession } from "@/lib/portal/viewer";
import { questionnaireLink } from "@/lib/services/tax-center";
import { recordQuestionnaireOpened } from "@/lib/services/questionnaire-intake";

// The portal's "Start Questionnaire" goes through here so the office sees
// "In Progress" when the client opens the form; then on to the signed Jotform link.
export async function GET(req: Request, { params }: { params: Promise<{ year: string }> }) {
  // View as Client: staff never open the client's own questionnaire (that would mark it "In
  // Progress" and could submit answers as the client). Say so instead of asking for a client login.
  if (await getPreviewSession()) {
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>View as Client</title><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#0a1a44"><h1 style="font-size:1.25rem">View as Client</h1><p>Here the client would open their tax questionnaire. It isn't opened in View as Client, so nothing is marked as started and no answers are sent for them.</p><p><a href="javascript:history.back()">← Back to the client's portal</a></p></body>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const user = await requirePortalUser();
  const { year } = await params;
  const clientId = new URL(req.url).searchParams.get("c") ?? "";
  const taxYear = Number(year);
  let url: string | null = null;
  try {
    url = await questionnaireLink(user, clientId, taxYear); // checks this user's tax access to the client
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!url) return new Response("This questionnaire isn't available yet.", { status: 404 });
  await recordQuestionnaireOpened(clientId, taxYear);
  return Response.redirect(url, 302);
}
