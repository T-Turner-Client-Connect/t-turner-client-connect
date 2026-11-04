import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";

/**
 * The bookkeeping dashboard now opens at /bookkeeping/[clientId] (Bookkeeping Clients -> a client).
 * Old links to /close keep working: same month (?period, ?year&month) and #section.
 */
export default async function CloseRedirect({ params, searchParams }: { params: Promise<{ clientId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUser();
  const { clientId } = await params;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) for (const x of Array.isArray(v) ? v : v ? [v] : []) q.append(k, x);
  const qs = q.toString();
  redirect(`/bookkeeping/${encodeURIComponent(clientId)}${qs ? `?${qs}` : ""}`);
}
