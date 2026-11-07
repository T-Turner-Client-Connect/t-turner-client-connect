import { PageHeader } from "@/components/ui";
import { TaxDocsOnline } from "@/components/portal/tax-docs-online";
import { ResourceCenter } from "@/components/resources/resource-center";
import { portalViewer } from "@/lib/portal/viewer";
import { previewFormAction } from "@/app/actions/preview";
import { prisma } from "@/lib/prisma";
import { isStateCode } from "@/lib/resources/catalog";
import { coverage, resourcesFor, visibleFaqs } from "@/lib/services/resources";

export const metadata = { title: "Resource Center" };

export default async function ResourcesPage({ searchParams }: { searchParams: Promise<{ account?: string; state?: string }> }) {
  const sp = await searchParams;
  const v = await portalViewer("resources", sp.account);
  const { user, current } = v;
  if (!current) return null;
  const me = user ? await prisma.portalUser.findUniqueOrThrow({ where: { id: user.id }, select: { preferredState: true } }) : { preferredState: null };
  const client = await prisma.client.findUnique({ where: { id: current.clientId }, select: { state: true } });
  // URL choice → saved preference → the client's address on file → Alabama (our home office).
  const state = [sp.state, me.preferredState, client?.state?.toUpperCase(), "AL"].find((s) => isStateCode(s ?? null))!;
  const [rows, faqs] = await Promise.all([resourcesFor(state), visibleFaqs()]);
  const items = rows.map((r) => ({
    id: r.id,
    jurisdiction: r.jurisdiction,
    county: r.county,
    city: r.city,
    category: r.category,
    title: r.title,
    purpose: r.purpose,
    agency: r.agency,
    url: r.url,
    phone: r.phone,
    status: r.status,
    notes: r.notes,
    lastVerified: r.lastVerifiedAt ? r.lastVerifiedAt.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "America/Chicago" }) : null,
  }));
  return (
    <>
      <PageHeader title="Resources" subtitle="Official agency websites for all 50 states, Washington, D.C. and federal programs." />
      <div className="mb-6"><TaxDocsOnline /></div>
      <ResourceCenter clientId={current.clientId} initialState={state} resources={items} faqs={faqs.map((f) => ({ id: f.id, question: f.question, answer: f.answer, tags: f.tags }))} coverage={coverage(state, rows)} previewAction={v.readOnly ? previewFormAction : null} />
    </>
  );
}
