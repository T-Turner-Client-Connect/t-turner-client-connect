"use server";

import { unsubscribeWithToken } from "@/lib/services/comm-prefs";

export type UnsubscribeState = { ok?: boolean; scope?: "THIS" | "ALL"; error?: string; at?: number } | null;

/** Public (no sign-in): the signed link itself is the permission. Success only after the save commits. */
export async function unsubscribeAction(token: string, _prev: UnsubscribeState, fd: FormData): Promise<UnsubscribeState> {
  const scope = fd.get("scope") === "ALL" ? "ALL" : "THIS";
  try {
    const r = await unsubscribeWithToken(token, scope, "EMAIL_LINK");
    if (!r.ok) return { error: r.reason === "expired" ? "This link has expired. Sign in to your portal to change your preferences, or call our office." : "This link isn't valid. Sign in to your portal to change your preferences.", at: Date.now() };
    return { ok: true, scope, at: Date.now() };
  } catch (err) {
    console.error("Unsubscribe failed:", err instanceof Error ? err.name : "unknown");
    return { error: "We couldn't save that just now. Nothing was changed. Please try again, or call our office.", at: Date.now() };
  }
}
