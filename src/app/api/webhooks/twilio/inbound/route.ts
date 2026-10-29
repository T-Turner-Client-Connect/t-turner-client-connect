import { formParams, publicUrlFor, verifyTwilioRequest } from "@/lib/twilio";
import { handleInboundSms } from "@/lib/services/inbound-sms";

const xml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

// Twilio "A message comes in" webhook. Requests without a valid
// X-Twilio-Signature are rejected before anything is read or stored.
export async function POST(req: Request) {
  if (!process.env.TWILIO_AUTH_TOKEN) return new Response("Twilio not configured", { status: 503 });
  const params = await formParams(req);
  if (!verifyTwilioRequest(publicUrlFor(req), params, req.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature", { status: 403 });
  }
  const { reply } = await handleInboundSms(params);
  const twiml = reply ? `<Response><Message>${xml(reply)}</Message></Response>` : "<Response/>";
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${twiml}`, { headers: { "Content-Type": "text/xml" } });
}
