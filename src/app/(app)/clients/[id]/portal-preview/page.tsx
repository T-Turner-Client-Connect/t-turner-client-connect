import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";

/**
 * The old embedded View as Client address. View as Client now turns the whole screen into the
 * client's own portal (see /view-as-client/[clientId] and lib/portal/viewer.ts).
 */
export default async function PortalPreview({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  redirect(`/view-as-client/${encodeURIComponent(id)}`);
}
