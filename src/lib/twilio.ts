import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { appUrl } from "@/lib/integrations";
import { prisma } from "@/lib/prisma";
import { blockNumber, smsBlock, SMS_BLOCKED_TEXT, TWILIO_UNSUBSCRIBED } from "@/lib/sms-block";

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

export type TwilioMessageRecord = {
  sid: string; to: string | null; from: string | null; messagingServiceSid: string | null; status: string | null;
  errorCode: number | null; errorMessage: string | null; dateCreated: string | null; dateSent: string | null; dateUpdated: string | null; numSegments: string | null; direction: string | null;
};

/**
 * Read-only: Twilio's own record of one message (GET, never sends). Used by the Settings test
 * history so the destination, sender, final status and error code come straight from Twilio.
 */
export async function fetchTwilioMessage(messageSid: string): Promise<{ ok: true; record: TwilioMessageRecord } | { ok: false; detail: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return { ok: false, detail: "Twilio not set up" };
  if (!/^(SM|MM)[0-9a-f]{32}$/i.test(messageSid)) return { ok: false, detail: "Not a Twilio message ID" };
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages/${messageSid}.json`, {
      method: "GET",
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, detail: `Twilio lookup failed (HTTP ${res.status})` };
    const j = (await res.json()) as Record<string, unknown>;
    const s = (k: string) => (typeof j[k] === "string" ? (j[k] as string) : null);
    return {
      ok: true,
      record: {
        sid: s("sid") ?? messageSid, to: s("to"), from: s("from"), messagingServiceSid: s("messaging_service_sid"), status: s("status"),
        errorCode: typeof j.error_code === "number" ? j.error_code : j.error_code ? Number(j.error_code) : null, errorMessage: s("error_message"),
        dateCreated: s("date_created"), dateSent: s("date_sent"), dateUpdated: s("date_updated"), numSegments: s("num_segments"), direction: s("direction"),
      },
    };
  } catch {
    return { ok: false, detail: "Couldn't reach Twilio for the lookup" };
  }
}

/**
 * Sends one text. Returns the Twilio Message SID when Twilio accepts it.
 * Never sends to a number that replied STOP (blocked: true), and a Twilio
 * 21610 "unsubscribed recipient" error blocks the number for every sender.
 */
export async function sendSms(to: string, body: string): Promise<{ ok: boolean; sid?: string; detail: string; blocked?: boolean }> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from: Record<string, string> | null = process.env.TWILIO_MESSAGING_SERVICE_SID
    ? { MessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID }
    : process.env.TWILIO_FROM_NUMBER
      ? { From: process.env.TWILIO_FROM_NUMBER }
      : null;
  if (await smsBlock(prisma, to)) return { ok: false, blocked: true, detail: SMS_BLOCKED_TEXT };
  if (!sid || !token || !from) return { ok: false, detail: "Text provider (Twilio) not set up" };
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, Body: body, StatusCallback: `${appUrl()}/api/webhooks/twilio/status`, ...from }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { code?: number };
    if (Number(err.code) === TWILIO_UNSUBSCRIBED) {
      await blockNumber(prisma, to, "Twilio error 21610 (recipient replied STOP)");
      return { ok: false, blocked: true, detail: `${SMS_BLOCKED_TEXT} (Twilio error 21610)` };
    }
    return { ok: false, detail: `Twilio rejected the message (HTTP ${res.status}${err.code ? `, code ${err.code}` : ""})` };
  }
  const json = (await res.json()) as { sid?: string };
  return { ok: true, sid: json.sid, detail: "Accepted by Twilio" };
}
