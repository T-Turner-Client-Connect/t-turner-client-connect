import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice } from "@/components/ui";
import { assignContractAction, contractPdfAction, verifyContractAction } from "@/app/actions/workspace";
import { prisma } from "@/lib/prisma";
import { contractFormUrl, jotformStatus } from "@/lib/services/contracts";
import { fmtDate } from "@/lib/format";

/**
 * Jotform contracts for one client — older contracts and special ones Tabitha still builds
 * in Jotform. Same assign form and completion tracking as before (moved here from the
 * Portal tab). New agreements are made in Client Connect; this is the alternative.
 */
export async function JotformContractsCard({ clientId }: { clientId: string }) {
  const contracts = await prisma.contractAssignment.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, include: { pdfDocument: { select: { title: true } } } });
  const jot = jotformStatus();
  return (
    <div data-testid="jotform-contracts">
        <Card title="Jotform contracts (older or custom)" actions={<Badge tone={jot.verifiedCompletion ? "green" : "amber"}>{jot.verifiedCompletion ? "Connected" : "Completion tracking: setup required"}</Badge>}>
          {!jot.verifiedCompletion && (
            <div className="mb-3"><Notice tone="warn">{jot.label}. Until then, staff confirm completion manually after checking the submission in Jotform.</Notice></div>
          )}
          <ul className="mb-3 divide-y divide-navy-100 text-sm">
            {contracts.map((c) => (
              <li key={c.id} className="py-2">
                <p className="flex flex-wrap items-center gap-2">
                  <strong>{c.title}</strong>
                  <Badge tone={c.status === "COMPLETED" ? "green" : c.status === "CANCELLED" ? "gray" : "amber"}>{c.status === "ASSIGNED" ? "Waiting for client" : c.status.charAt(0) + c.status.slice(1).toLowerCase()}</Badge>
                  {c.completionSource === "staff_verified" && <Badge tone="gray">Verified by staff</Badge>}
                  {c.completionSource === "jotform_api" && <Badge tone="navy">Confirmed by Jotform</Badge>}
                </p>
                <p className="text-xs text-slate-600">Form {c.jotformFormId}{c.dueAt && ` · due ${fmtDate(c.dueAt)}`}{c.submissionId && ` · submission ${c.submissionId}`}{c.pdfDocument && ` · PDF: ${c.pdfDocument.title}`}</p>
                <a className="text-xs underline" href={contractFormUrl(c)} target="_blank" rel="noopener">Open the client&apos;s form link</a>
                {c.status === "ASSIGNED" && (
                  <ActionForm action={verifyContractAction.bind(null, clientId, c.id)} className="mt-1 flex flex-wrap gap-2">
                    <input className="input w-56" name="submissionId" placeholder="Jotform submission ID" aria-label="Submission ID" required />
                    <Button type="submit" variant="ghost">Mark complete (checked in Jotform)</Button>
                  </ActionForm>
                )}
                {c.status === "COMPLETED" && !c.pdfDocument && (
                  <ActionForm action={contractPdfAction.bind(null, clientId, c.id)} className="mt-1 flex flex-wrap gap-2">
                    <input className="input w-56" type="file" name="file" accept="application/pdf" aria-label="Completed PDF" required />
                    <Button type="submit" variant="ghost">Save completed PDF</Button>
                  </ActionForm>
                )}
              </li>
            ))}
            {contracts.length === 0 && <li className="text-slate-600">No contracts assigned.</li>}
          </ul>
          <ActionForm action={assignContractAction.bind(null, clientId)} className="grid gap-2 sm:grid-cols-2" resetOnSuccess>
            <Field label="Contract name"><input className="input" name="title" required placeholder="Bookkeeping engagement letter" /></Field>
            <Field label="Jotform form ID" hint="The number in the form's URL."><input className="input" name="formId" required inputMode="numeric" /></Field>
            <Field label="Due"><input className="input" type="date" name="dueAt" /></Field>
            <div className="flex items-end"><Button type="submit">Assign contract</Button></div>
            <p className="text-xs text-slate-600 sm:col-span-2">Add a hidden field named <code>assignment_ref</code> to the Jotform form so submissions can be matched to this client. Jotform contracts are not used for tax-return signatures.</p>
          </ActionForm>
        </Card>
    </div>
  );
}
