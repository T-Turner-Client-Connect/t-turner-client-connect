import type { Contact } from "@prisma/client";
import { ActionForm } from "@/components/action-form";
import { confirmIdentityAction } from "@/app/actions/tax-center";
import { Badge, Button, Card, Field, Notice } from "@/components/ui";
import {
  assignContractAction,
  clientUpdateAction,
  contractPdfAction,
  createSignatureAction,
  deadlineAction,
  invitePortalAction,
  offlineSignedAction,
  portalAccessAction,
  resetPortalMfaAction,
  sendSignatureAction,
  verifyContractAction,
} from "@/app/actions/workspace";
import { prisma } from "@/lib/prisma";
import { contractFormUrl, jotformStatus } from "@/lib/services/contracts";
import { SIGNATURE_LABELS, signingProviderStatus } from "@/lib/services/signatures";
import { fmtDate, fmtDateTime } from "@/lib/format";

const PERMS = [
  ["canMessage", "Messages"],
  ["canUpload", "Upload files"],
  ["canViewBookkeeping", "Bookkeeping"],
  ["canViewTax", "Tax documents"],
  ["canViewContracts", "Contracts"],
] as const;

export async function PortalTab({ clientId, contacts }: { clientId: string; contacts: Contact[] }) {
  const [grants, invites, updates, deadlines, contracts, signatures, taxDocs] = await Promise.all([
    prisma.portalAccess.findMany({ where: { clientId }, include: { portalUser: true }, orderBy: { createdAt: "asc" } }),
    prisma.portalInvite.findMany({ where: { clientId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } }),
    prisma.announcement.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take: 10, include: { createdBy: { select: { name: true } } } }),
    prisma.clientDeadline.findMany({ where: { clientId }, orderBy: { dueAt: "asc" } }),
    prisma.contractAssignment.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, include: { pdfDocument: { select: { title: true } } } }),
    prisma.signatureRequest.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, include: { signers: true, packageDocument: { select: { title: true } }, signedDocument: { select: { title: true } } } }),
    prisma.document.findMany({ where: { clientId, category: "TAXES", deletedAt: null }, select: { id: true, title: true }, orderBy: { createdAt: "desc" } }),
  ]);
  const jot = jotformStatus();
  const signing = signingProviderStatus();

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Portal logins">
        {grants.length === 0 && <p className="mb-3 text-sm text-slate-600">Nobody has portal access to this account yet.</p>}
        <ul className="mb-4 divide-y divide-navy-100">
          {grants.map((g) => (
            <li key={g.id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold">{g.portalUser.name} <span className="font-normal text-slate-600">· {g.portalUser.email}</span></p>
                  <p className="text-xs text-slate-600">
                    {g.role === "OWNER" ? "Owner" : "Authorized contact"} · last sign-in {g.portalUser.lastLoginAt ? fmtDateTime(g.portalUser.lastLoginAt) : "never"} · {g.portalUser.mfaEnabledAt ? "2-step on" : "2-step not set up"} ·{" "}
                    {g.portalUser.emailVerifiedAt ? "email verified" : g.portalUser.identityVerifiedAt ? `identity confirmed by staff ${fmtDate(g.portalUser.identityVerifiedAt)}` : "not verified — past-year tax records locked"}
                  </p>
                </div>
                {g.revokedAt ? <Badge tone="red">Access revoked</Badge> : <Badge tone="green">Active</Badge>}
              </div>
              <ActionForm action={portalAccessAction.bind(null, clientId, g.id)} className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                {PERMS.map(([k, label]) => (
                  <label key={k} className="flex items-center gap-1"><input type="checkbox" name={k} defaultChecked={g[k]} className="accent-navy-900" /> {label}</label>
                ))}
                <select className="input w-auto" name="revoke" defaultValue="" aria-label="Access">
                  <option value="">Keep access as is</option>
                  {g.revokedAt ? <option value="false">Restore access</option> : <option value="true">Revoke access</option>}
                </select>
                <Button type="submit" variant="secondary">Save</Button>
              </ActionForm>
              {!g.portalUser.emailVerifiedAt && !g.portalUser.identityVerifiedAt && !g.revokedAt && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-sm underline">Confirm identity to unlock past-year records</summary>
                  <ActionForm action={confirmIdentityAction.bind(null, clientId, g.portalUserId)} className="mt-1 flex flex-wrap items-end gap-2">
                    <Field label="How you confirmed it"><input className="input w-80" name="note" placeholder="e.g. Called the number on file, verified DOB" required /></Field>
                    <Button type="submit" variant="secondary">Confirm identity</Button>
                  </ActionForm>
                </details>
              )}
              {g.portalUser.mfaEnabledAt && (
                <ActionForm action={resetPortalMfaAction.bind(null, clientId, g.portalUserId)} confirm="Reset their two-step verification? Only do this after confirming their identity by phone." className="mt-1">
                  <Button type="submit" variant="ghost">Reset 2-step (lost phone)</Button>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
        {invites.length > 0 && (
          <ul className="mb-3 text-sm">{invites.map((i) => <li key={i.id}>Invitation pending: {i.name} ({i.email}) · expires {fmtDate(i.expiresAt)}</li>)}</ul>
        )}
        <h3 className="mb-2 font-semibold">Invite to the portal</h3>
        <ActionForm action={invitePortalAction.bind(null, clientId)} className="grid gap-2 sm:grid-cols-2" resetOnSuccess>
          <Field label="Name"><input className="input" name="name" required /></Field>
          <Field label="Email"><input className="input" type="email" name="email" required /></Field>
          <Field label="Role">
            <select className="input" name="role" defaultValue="OWNER">
              <option value="OWNER">Owner / taxpayer</option>
              <option value="AUTHORIZED_CONTACT">Authorized contact (own login)</option>
            </select>
          </Field>
          <Field label="Linked contact">
            <select className="input" name="contactId" defaultValue="">
              <option value="">—</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <p className="text-xs text-slate-600 sm:col-span-2">Authorized contacts don&apos;t see tax documents unless you allow it. An owner with several businesses keeps one login — invite the same email from each business.</p>
          <div><Button type="submit">Create invitation</Button></div>
        </ActionForm>
      </Card>

      <div className="space-y-4">
        <Card title="Account updates">
          <ActionForm action={clientUpdateAction.bind(null, clientId)} className="space-y-2" resetOnSuccess>
            <input className="input" name="title" required placeholder="Title, e.g. Your 2025 return was accepted" aria-label="Update title" />
            <textarea className="input" name="body" rows={3} required placeholder="Shown on their portal dashboard" aria-label="Update message" />
            <Button type="submit">Post update</Button>
          </ActionForm>
          {updates.length > 0 && (
            <ul className="mt-3 divide-y divide-navy-100 text-sm">
              {updates.map((u) => <li key={u.id} className="py-1.5"><strong>{u.title}</strong> <span className="text-slate-600">· {u.createdBy.name} · {fmtDate(u.publishedAt)}</span></li>)}
            </ul>
          )}
        </Card>
        <Card title="Deadlines">
          <ul className="mb-2 text-sm">
            {deadlines.map((d) => <li key={d.id}>{fmtDate(d.dueAt)} — {d.title} {!d.visibleToClient && <Badge tone="gray">Staff only</Badge>}</li>)}
            {deadlines.length === 0 && <li className="text-slate-600">No deadlines.</li>}
          </ul>
          <ActionForm action={deadlineAction.bind(null, clientId)} className="flex flex-wrap items-end gap-2" resetOnSuccess>
            <Field label="Deadline"><input className="input" name="title" required placeholder="e.g. Q3 estimated tax payment" /></Field>
            <Field label="Date"><input className="input" type="date" name="dueAt" required /></Field>
            <label className="flex items-center gap-1 pb-2 text-sm"><input type="checkbox" name="visibleToClient" defaultChecked className="accent-navy-900" /> Show to client</label>
            <Button type="submit" variant="secondary">Add</Button>
          </ActionForm>
        </Card>
      </div>

      <Card title="Contracts (Jotform)" actions={<Badge tone={jot.verifiedCompletion ? "green" : "amber"}>{jot.verifiedCompletion ? "Connected" : "Completion tracking: setup required"}</Badge>}>
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

      <Card title="Tax signature requests" actions={<Badge tone="amber">{signing.label}</Badge>}>
        <div className="mb-3">
          <Notice tone="warn" title="E-signature provider: setup required">
            Tax e-signatures need a provider verified for the specific forms, IRS identity-verification rules, joint-return signers and record keeping. Until one is connected, prepare
            the request here and record copies signed outside the app. A typed name, checkbox or ordinary upload is never treated as an e-signature.
          </Notice>
        </div>
        <ul className="mb-3 divide-y divide-navy-100 text-sm">
          {signatures.map((s) => (
            <li key={s.id} className="py-2">
              <p className="flex flex-wrap items-center gap-2"><strong>{s.title}</strong><Badge tone={s.status === "SIGNED_OFFLINE_UPLOADED" || s.status === "COMPLETED" ? "green" : "gray"}>{SIGNATURE_LABELS[s.status]}</Badge></p>
              <p className="text-xs text-slate-600">
                Package: {s.packageDocument?.title ?? "—"} · Signers: {s.signers.map((x) => `${x.name} (${x.role.toLowerCase()})`).join(", ")}
                {s.signedDocument && ` · Signed copy: ${s.signedDocument.title}`}
              </p>
              {s.status === "DRAFT" && (
                <div className="mt-1 flex flex-wrap gap-2">
                  <ActionForm action={sendSignatureAction.bind(null, clientId, s.id)}><Button type="submit" variant="secondary">Send for e-signature</Button></ActionForm>
                  <details>
                    <summary className="cursor-pointer py-2 text-sm underline">Record signed copy</summary>
                    <ActionForm action={offlineSignedAction.bind(null, clientId, s.id)} className="mt-1 space-y-2">
                      <input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required aria-label="Signed copy" />
                      <label className="flex items-center gap-2"><input type="checkbox" name="publish" className="accent-navy-900" /> Show the signed copy in their portal</label>
                      <Button type="submit">Save (signed outside the app)</Button>
                    </ActionForm>
                  </details>
                </div>
              )}
            </li>
          ))}
          {signatures.length === 0 && <li className="text-slate-600">No signature requests.</li>}
        </ul>
        {taxDocs.length === 0 ? (
          <p className="text-sm text-slate-600">Upload the tax package to the Documents tab (category Taxes) to prepare a signature request.</p>
        ) : (
          <ActionForm action={createSignatureAction.bind(null, clientId)} className="grid gap-2 sm:grid-cols-2" resetOnSuccess>
            <Field label="Title"><input className="input" name="title" required placeholder="2025 Form 8879" /></Field>
            <Field label="Tax year"><input className="input" name="taxYear" inputMode="numeric" /></Field>
            <Field label="Tax package" className="sm:col-span-2">
              <select className="input" name="packageDocumentId" required>
                {taxDocs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
              </select>
            </Field>
            {[0, 1].map((i) => (
              <fieldset key={i} className="grid gap-2 sm:col-span-2 sm:grid-cols-3">
                <legend className="text-sm font-semibold">{i === 0 ? "Signer" : "Second signer (joint return)"}</legend>
                <input className="input" name={`signer${i}Name`} placeholder="Name" required={i === 0} aria-label={`Signer ${i + 1} name`} />
                <input className="input" name={`signer${i}Email`} type="email" placeholder="Email" aria-label={`Signer ${i + 1} email`} />
                <select className="input" name={`signer${i}Role`} defaultValue={i === 0 ? "TAXPAYER" : "SPOUSE"} aria-label={`Signer ${i + 1} role`}>
                  <option value="TAXPAYER">Taxpayer</option><option value="SPOUSE">Spouse</option><option value="OFFICER">Officer</option><option value="OTHER">Other</option>
                </select>
              </fieldset>
            ))}
            <div><Button type="submit">Save draft request</Button></div>
          </ActionForm>
        )}
      </Card>
    </div>
  );
}
