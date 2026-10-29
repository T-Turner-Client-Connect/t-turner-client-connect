import { formParams, publicUrlFor, verifyTwilioRequest } from "@/lib/twilio";
import { handleStatusCallback } from "@/lib/services/inbound-sms";

// Twilio delivery-status callback (set automatically on every message we send).
export async function POST(req: Request) {
  if (!process.env.TWILIO_AUTH_TOKEN) return new Response("Twilio not configured", { status: 503 });
  const params = await formParams(req);
  if (!verifyTwilioRequest(publicUrlFor(req), params, req.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature", { status: 403 });
  }
  await handleStatusCallback(params);
  return new Response(null, { status: 204 });
}
