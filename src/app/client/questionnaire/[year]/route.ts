import { requirePortalUser } from "@/lib/portal/session";
import { questionnaireLink } from "@/lib/services/tax-center";
import { recordQuestionnaireOpened } from "@/lib/services/questionnaire-intake";

// The portal's "Start Questionnaire" goes through here so the office sees
// "In Progress" when the client opens the form; then on to the signed Jotform link.
export async function GET(req: Request, { params }: { params: Promise<{ year: string }> }) {
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
