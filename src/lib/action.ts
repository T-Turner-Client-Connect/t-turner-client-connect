import "server-only";
import { unstable_rethrow } from "next/navigation";
import { chicagoLocalToUtc } from "@/lib/tz";
import { ForbiddenError } from "@/lib/auth/actor";
import { ValidationError } from "@/lib/services/clients";
import { ImportError } from "@/lib/services/imports";

export type ActionState = { error?: string; ok?: string; at?: number; codes?: string[]; link?: string } | null;

/**
 * Runs a Server Action body and turns expected failures into a message for
 * the form. Unexpected errors are logged without their payload.
 */
export async function run(fn: () => Promise<string | void>): Promise<ActionState> {
  try {
    const ok = await fn();
    return { ok: ok || "Saved.", at: Date.now() };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof ValidationError || err instanceof ForbiddenError || err instanceof ImportError) {
      return { error: err.message, at: Date.now() };
    }
    console.error("Action failed:", err instanceof Error ? err.name : "unknown error");
    return { error: "Something went wrong. Please try again.", at: Date.now() };
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
