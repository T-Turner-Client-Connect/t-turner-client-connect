import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Notice, PageHeader } from "@/components/ui";
import { portalViewer } from "@/lib/portal/viewer";
import { requireClientAccess } from "@/lib/portal/access";
import { PreviewOffNote } from "@/components/portal/preview-off";
import { prisma } from "@/lib/prisma";
import { contractFormUrl } from "@/lib/services/contracts";

export const metadata = { title: "Complete form" };

export default async function PortalContract({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const contract = await prisma.contractAssignment.findUnique({ where: { id } });
  if (!contract) notFound();
  const v = await portalViewer("contract", contract.clientId);
  // Throws (403) unless this user may see contracts for this account; View as Client: this client only.
  if (v.user) await requireClientAccess(v.user.id, contract.clientId, "contracts");
  if (!v.current?.canViewContracts) notFound();
  const url = contractFormUrl(contract);
  return (
    <>
      <PageHeader title={contract.title} subtitle={<Badge tone={contract.status === "COMPLETED" ? "green" : "amber"}>{contract.status === "COMPLETED" ? "Completed" : "To complete"}</Badge>} />
      {contract.status === "COMPLETED" ? (
        <Notice tone="success">Thank you — this form is complete. A copy will appear in your Documents when available.</Notice>
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-700">
            This form is provided securely by Jotform on behalf of T. Turner &amp; Associates. It will show as complete here once Jotform confirms your submission.
            Trouble with the form below? <a className="font-semibold underline" href={url} target="_blank" rel="noopener">Open it in a new tab (Jotform)</a>.
          </p>
          {v.readOnly ? (
            // The outside form can't be made read-only, so View as Client shows its place instead of loading it.
            <div className="flex h-64 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-navy-200 bg-white text-center text-sm text-slate-700" data-testid="preview-jotform-off">
              <p>The client fills in this form (Jotform) here.</p>
              <PreviewOffNote />
            </div>
          ) : (
            <iframe title={contract.title} src={url} className="h-[75vh] w-full rounded-xl border border-navy-100 bg-white" allow="geolocation 'none'; camera 'none'; microphone 'none'" />
          )}
        </>
      )}
      <p className="mt-4 text-sm"><Link className="underline" href={`/client/contracts?account=${contract.clientId}`}>← Back to forms</Link></p>
    </>
  );
}
