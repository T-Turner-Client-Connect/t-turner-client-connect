import { handleJotformWebhook } from "@/lib/services/contracts";

// Jotform webhook: https://<site>/api/webhooks/jotform?secret=<JOTFORM_WEBHOOK_SECRET>
// Jotform can't sign requests or send custom headers, so the secret travels
// in the URL; it is never logged or echoed here, and responses are not cached.
// The body is only used to find the submission ID; everything else is
// re-fetched from the Jotform API before anything is recorded.
const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  const secret = new URL(req.url).searchParams.get("secret");
  let submissionId: string | null = null;
  try {
    const form = await req.formData();
    const v = form.get("submissionID");
    submissionId = typeof v === "string" ? v : null;
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });
  }
  const { status, result } = await handleJotformWebhook(secret, submissionId);
  return Response.json({ result }, { status, headers: NO_STORE });
}

export function GET() {
  return Response.json({ error: "Method not allowed" }, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
}
