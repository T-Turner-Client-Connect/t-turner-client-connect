"use server";

import { headers } from "next/headers";
import { clientIp } from "@/lib/auth/session";
import { submitSmsConsent } from "@/lib/services/sms-consent";
import { ValidationError } from "@/lib/services/clients";

export type ConsentState = { ok?: boolean; error?: string; at?: number } | null;

/** Public (no login). Reports success only after the database commit. */
export async function saveSmsConsentAction(_prev: ConsentState, fd: FormData): Promise<ConsentState> {
  const str = (k: string) => (typeof fd.get(k) === "string" ? (fd.get(k) as string) : "");
  try {
    await submitSmsConsent({
      name: str("name"),
      phone: str("phone"),
      service: fd.get("service") === "on",
      marketing: fd.get("marketing") === "on",
      sourcePage: "/sms-consent",
      ip: await clientIp(),
      userAgent: (await headers()).get("user-agent"),
      honeypot: str("company_website"),
    });
    return { ok: true, at: Date.now() };
  } catch (err) {
    if (err instanceof ValidationError) return { error: err.message, at: Date.now() };
    console.error("SMS consent save failed:", err instanceof Error ? err.name : "unknown");
    return { error: "We couldn't save your preferences. Nothing was changed. Please try again, or call our office.", at: Date.now() };
  }
}
