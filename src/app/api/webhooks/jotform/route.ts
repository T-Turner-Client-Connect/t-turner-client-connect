import { handleJotformWebhook } from "@/lib/services/contracts";

// Jotform webhook: https://<site>/api/webhooks/jotform?secret=<JOTFORM_WEBHOOK_SECRET>
// The body is only used to find the submission ID; everything else is
// re-fetched from the Jotform API before any status changes.
export async function POST(req: Request) {
  const secret = new URL(req.url).searchParams.get("secret");
  let submissionId: string | null = null;
  try {
    const form = await req.formData();
    const v = form.get("submissionID");
    submissionId = typeof v === "string" ? v : null;
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  const { status, result } = await handleJotformWebhook(secret, submissionId);
  return Response.json({ result }, { status });
}
