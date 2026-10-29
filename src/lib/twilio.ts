import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { appUrl } from "@/lib/integrations";

/**
 * Twilio request validation: HMAC-SHA1 (auth token) over the full public URL
 * followed by every POST parameter name+value, sorted by name, base64.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function verifyTwilioRequest(url: string, params: Record<string, string>, signature: string | null): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || !signature) return false;
  const expected = Buffer.from(twilioSignature(token, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The public URL Twilio called (Twilio signs the URL configured in its console). */
export function publicUrlFor(req: Request): string {
  const u = new URL(req.url);
  return `${appUrl()}${u.pathname}${u.search}`;
}

export async function formParams(req: Request): Promise<Record<string, string>> {
  const fd = await req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

export function twilioConfigured() {
  const e = process.env;
  return Boolean(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && (e.TWILIO_MESSAGING_SERVICE_SID || e.TWILIO_FROM_NUMBER));
}

/** Sends one text. Returns the Twilio Message SID when Twilio accepts it. */
export async function sendSms(to: string, body: string): Promise<{ ok: boolean; sid?: string; detail: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from: Record<string, string> | null = process.env.TWILIO_MESSAGING_SERVICE_SID
    ? { MessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID }
    : process.env.TWILIO_FROM_NUMBER
      ? { From: process.env.TWILIO_FROM_NUMBER }
      : null;
  if (!sid || !token || !from) return { ok: false, detail: "Text provider (Twilio) not set up" };
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, Body: body, StatusCallback: `${appUrl()}/api/webhooks/twilio/status`, ...from }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { code?: number };
    return { ok: false, detail: `Twilio rejected the message (HTTP ${res.status}${err.code ? `, code ${err.code}` : ""})` };
  }
  const json = (await res.json()) as { sid?: string };
  return { ok: true, sid: json.sid, detail: "Accepted by Twilio" };
}
