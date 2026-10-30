import { verifyResendSignature } from "@/lib/resend-webhook";
import { applyInviteEmailEvent } from "@/lib/services/staff-invitations";
import { applyActivationEmailEvent } from "@/lib/services/client-signup";

// Resend delivery events, signed with the endpoint's secret (RESEND_WEBHOOK_SECRET).
// Staff invitations move to Delivered / Delivery failed only from these events.
export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return new Response("Not configured", { status: 503 });
  const body = await req.text();
  const ok = verifyResendSignature(
    secret,
    { id: req.headers.get("svix-id") ?? "", timestamp: req.headers.get("svix-timestamp") ?? "", signature: req.headers.get("svix-signature") ?? "" },
    body,
  );
  if (!ok) return new Response("Invalid signature", { status: 403 });
  let event: { type?: string; data?: { email_id?: string; bounce?: { message?: string }; failed?: { reason?: string } } };
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("Bad payload", { status: 400 });
  }
  const emailId = event.data?.email_id;
  if (event.type && emailId) {
    const reason = event.data?.bounce?.message ?? event.data?.failed?.reason;
    // Staff invitations and client activation emails each match their own provider ids.
    if (!(await applyInviteEmailEvent(event.type, emailId, reason))) await applyActivationEmailEvent(event.type, emailId, reason);
  }
  return new Response(null, { status: 204 });
}
