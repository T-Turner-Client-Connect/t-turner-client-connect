import Link from "next/link";
import { notFound } from "next/navigation";
import { Eye } from "lucide-react";
import { Card } from "@/components/ui";
import { PortalHomeView } from "@/components/portal/home-view";
import { PortalDocumentsView } from "@/components/portal/documents-view";
import { PortalTaxesView } from "@/components/portal/taxes-view";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { loadPortalDocuments, loadPortalHome, OWNER_PREVIEW_PERMS } from "@/lib/portal/views";
import { loadPortalTaxes } from "@/lib/portal/tax-view";
import { downloadToken } from "@/lib/services/documents";
import { audit } from "@/lib/audit";

export const metadata = { title: "Portal preview" };

/**
 * Read-only staff view of what an owner-level portal user sees. Every visit
 * is written to the audit log.
 */
export default async function PortalPreview({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const client = await prisma.client.findUnique({ where: { id }, select: { id: true, displayName: true, businessName: true } });
  if (!client) notFound();
  await audit(prisma, { actorId: user.id, action: "portal.staff_preview", entityType: "Client", entityId: id, clientId: id });
  const linkFor = (docId: string) => `/api/documents/${downloadToken(docId, { staffId: user.id })}`;
  const [home, docs, taxes] = await Promise.all([loadPortalHome(id, OWNER_PREVIEW_PERMS, null), loadPortalDocuments(id, OWNER_PREVIEW_PERMS), loadPortalTaxes(id)]);
  return (
    <div className="space-y-6">
      <div role="status" className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 border-gold-500 bg-gold-100 px-4 py-3 text-navy-950">
        <span className="flex items-center gap-2 font-semibold"><Eye className="size-5" aria-hidden /> STAFF VIEW — portal preview for {client.businessName || client.displayName} (read-only, owner permissions). This visit is logged.</span>
        <Link href={`/clients/${id}`} className="rounded-md bg-navy-900 px-3 py-1.5 text-sm font-semibold text-white">Exit preview</Link>
      </div>
      <section>
        <h2 className="mb-3 text-xl font-semibold">Home</h2>
        <PortalHomeView data={home} linkFor={linkFor} q="" readOnly />
      </section>
      <section>
        <h2 className="mb-3 text-xl font-semibold">Documents</h2>
        <PortalDocumentsView docs={docs} linkFor={linkFor} />
      </section>
      <section>
        <h2 className="mb-3 text-xl font-semibold">Taxes</h2>
        <PortalTaxesView data={taxes} linkFor={linkFor} />
      </section>
      <Card title="Not shown here">
        <p className="text-sm text-slate-600">Messages appear on the client&apos;s Messages tab (internal notes are never visible to clients). Authorized contacts may see less than the owner, depending on their permissions.</p>
      </Card>
    </div>
  );
}
