import "server-only";
import { sign, verifySignature } from "@/lib/crypto";

/**
 * Email unsubscribe links. The token carries who it was sent to (client,
 * contact, email address) and what kind of email it was (promotional or a
 * general business update), signed with an HMAC derived from
 * APP_ENCRYPTION_KEY — it can't be guessed or edited to point at someone
 * else. Links work for a year (the law requires at least 30 days).
 */
export type UnsubscribeKind = "PROMO" | "GENERAL";

export type UnsubscribePayload = {
  clientId: string;
  contactId: string | null;
  email: string;
  kind: UnsubscribeKind;
  issuedAt: number; // seconds
};

export const UNSUBSCRIBE_LIFETIME_S = 365 * 24 * 3600;

type Wire = { v: 1; c: string; p: string | null; e: string; k: UnsubscribeKind; t: number };

export function unsubscribeToken(input: Omit<UnsubscribePayload, "issuedAt">, now = Date.now()): string {
  const wire: Wire = { v: 1, c: input.clientId, p: input.contactId, e: input.email, k: input.kind, t: Math.floor(now / 1000) };
  const body = Buffer.from(JSON.stringify(wire)).toString("base64url");
  return `${body}.${sign(`unsub:${body}`)}`;
}

export type TokenCheck = { ok: true; payload: UnsubscribePayload } | { ok: false; reason: "invalid" | "expired" };

export function readUnsubscribeToken(token: string, now = Date.now()): TokenCheck {
  const [body, sig, extra] = String(token ?? "").split(".");
  if (!body || !sig || extra !== undefined || body.length > 2000) return { ok: false, reason: "invalid" };
  if (!verifySignature(`unsub:${body}`, sig)) return { ok: false, reason: "invalid" };
  let w: Wire;
  try {
    w = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (w?.v !== 1 || typeof w.c !== "string" || typeof w.e !== "string" || (w.k !== "PROMO" && w.k !== "GENERAL") || typeof w.t !== "number") return { ok: false, reason: "invalid" };
  if (now / 1000 - w.t > UNSUBSCRIBE_LIFETIME_S || w.t - now / 1000 > 300) return { ok: false, reason: "expired" };
  return { ok: true, payload: { clientId: w.c, contactId: w.p ?? null, email: w.e, kind: w.k, issuedAt: w.t } };
}
