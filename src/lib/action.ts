import "server-only";
import { unstable_rethrow } from "next/navigation";
import { chicagoLocalToUtc } from "@/lib/tz";
import { ForbiddenError } from "@/lib/auth/actor";
import { ValidationError } from "@/lib/services/clients";
import { ImportError } from "@/lib/services/imports";

export type ActionState = { error?: string; ok?: string; at?: number; codes?: string[]; link?: string; next?: { href: string; label: string } } | null;

/**
 * Runs a Server Action body and turns expected failures into a message for
 * the form. Unexpected errors are logged without their payload.
 */
export async function run(fn: () => Promise<string | void | { ok: string; next?: { href: string; label: string } }>): Promise<ActionState> {
  try {
    const r = await fn();
    if (r && typeof r === "object") return { ok: r.ok, next: r.next, at: Date.now() };
    return { ok: r || "Saved.", at: Date.now() };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof ValidationError || err instanceof ForbiddenError || err instanceof ImportError) {
      const next = (err as { next?: { href: string; label: string } }).next;
      return { error: err.message, at: Date.now(), ...(next ? { next } : {}) };
    }
    // Say what happened without exposing details; the reference ties the message to the server log.
    const ref = Math.random().toString(36).slice(2, 8).toUpperCase();
    const code = typeof err === "object" && err && "code" in err ? String((err as { code: unknown }).code) : "";
    console.error(`Action failed [${ref}]:`, err instanceof Error ? err.name : "unknown error", code);
    if (code === "P2021" || code === "P2022") {
      return { error: `Nothing was saved: the database is missing a recent update for this feature (the latest migration hasn't been applied). Please let your administrator know. Reference ${ref}.`, at: Date.now() };
    }
    if (code === "P2002") return { error: `Nothing was saved: this would create a duplicate record. Reference ${ref}.`, at: Date.now() };
    return { error: `Something went wrong and nothing was saved. Please try again; if it keeps happening, share reference ${ref} with your administrator.`, at: Date.now() };
  }
}

export function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}

export function dateOrNull(fd: FormData, key: string): Date | null {
  const v = str(fd, key);
  if (!v) return null;
  // Date-and-time fields are office (Central) time, not the server's time zone.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return chicagoLocalToUtc(v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
