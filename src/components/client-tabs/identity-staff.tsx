import type { Actor } from "@/lib/auth/actor";
import { Card, Notice } from "@/components/ui";
import { IdentitySection } from "@/components/identity-section";
import { downloadToken } from "@/lib/services/documents";
import { canStaffViewIdentity, staffIdentityOverview, unassignedBusinessIdentity } from "@/lib/services/identity";
import { IdentityAssignPanel } from "./identity-assign";
import { prisma } from "@/lib/prisma";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { fileQuestionnaireUploadAction, moveQuestionnaireIdentityAction, staffIpPinFlagAction, staffIpPinRevealAction, staffIpPinSaveAction } from "@/app/actions/identity";
import { ID_ROLES, ID_TYPES, identityCompletion, ipPinStatus, IRS_IP_PIN_URL, type IdRole } from "@/lib/services/identity";

/** Staff view of a client's Identity Documents (Admins and the assigned staff member only). */
export async function IdentityStaff({ clientId, user }: { clientId: string; user: Actor }) {
  if (!(await canStaffViewIdentity(user, clientId))) {
    return (
      <div id="identity" className="scroll-mt-6">
        <Notice title="Identity Documents">Only an Admin or this client&apos;s assigned staff member can open this section. Social Security cards and birth certificates are Admin-only.</Notice>
      </div>
    );
  }
  const [overview, unassigned] = await Promise.all([staffIdentityOverview(user, clientId), unassignedBusinessIdentity(user, clientId)]);
  const pending = overview.reduce((n, o) => n + o.slots.reduce((m, s) => m + s.pending.length, 0), 0);
  return (
    <div id="identity" className="scroll-mt-6">
      <Card title={<>Identity Documents{pending > 0 && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">{pending} pending verification</span>}</>}>
        {unassigned && <IdentityAssignPanel clientId={clientId} data={unassigned} viewerIsAdmin={user.role === "ADMIN"} />}
        <QuestionnaireIdentity clientId={clientId} people={overview.map((o) => o.person)} />
        <IpPinsStaff clientId={clientId} overview={overview} />
        <IdentitySection overview={overview} mode="staff" clientId={clientId} viewerIsAdmin={user.role === "ADMIN"} linkFor={(id) => `/api/documents/${downloadToken(id, { staffId: user.id })}`} />
      </Card>
    </div>
  );
}

/**
 * ID documents clients already sent with their Jotform questionnaire: one button files every one
 * the questionnaire identifies; anything else can be filed by hand. Staff with identity access only.
 */
async function QuestionnaireIdentity({ clientId, people }: { clientId: string; people: { id: string; name: string; role: string }[] }) {
  const uploads = await prisma.document.findMany({ where: { clientId, docType: "QUESTIONNAIRE_UPLOAD", deletedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true, title: true, year: true }, take: 60 });
  if (!uploads.length) return null;
  const choosable = people.filter((p) => p.role !== "OWNER");
  return (
    <section className="mb-4 rounded-2xl border border-gold-200 bg-ivory-50 p-4" data-testid="questionnaire-identity">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-navy-900"><strong>{uploads.length} questionnaire upload{uploads.length === 1 ? "" : "s"}</strong> from Jotform are in the tax folders. ID documents among them (licenses, birth certificates, Social Security cards, passports) can be filed here so no one uploads them again.</p>
        <ActionForm action={moveQuestionnaireIdentityAction.bind(null, clientId)}>
          <Button type="submit" data-testid="move-questionnaire-identity">Move Jotform ID documents to Identity</Button>
        </ActionForm>
      </div>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer font-semibold text-navy-900">File one by hand</summary>
        <ul className="mt-2 divide-y divide-ivory-200">
          {uploads.map((u) => (
            <li key={u.id} className="flex flex-col gap-2 py-2 md:flex-row md:items-end md:justify-between">
              <span className="min-w-0 break-words text-navy-900">{u.title}</span>
              <ActionForm action={fileQuestionnaireUploadAction.bind(null, clientId, u.id)} className="flex flex-wrap items-end gap-2" showSuccess>
                <select className="input py-1 text-xs" name="type" required defaultValue="" aria-label="What it is">
                  <option value="" disabled>What it is…</option>
                  {Object.entries(ID_TYPES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
                </select>
                <select className="input py-1 text-xs" name="personId" required defaultValue="" aria-label="Whose it is">
                  <option value="" disabled>Whose…</option>
                  {choosable.map((p) => <option key={p.id} value={p.id}>{p.name} ({ID_ROLES[p.role as IdRole] ?? p.role})</option>)}
                </select>
                <Button type="submit" variant="secondary">File into Identity</Button>
              </ActionForm>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/** Completion and the optional IRS IP PIN for each person (staff only; viewing a PIN is logged). */
async function IpPinsStaff({ clientId, overview }: { clientId: string; overview: Awaited<ReturnType<typeof staffIdentityOverview>> }) {
  const pins = await ipPinStatus(clientId);
  const done = identityCompletion(overview, pins);
  const people = overview.map((o) => o.person).filter((p) => p.role !== "OWNER");
  return (
    <section className="mb-4 rounded-2xl border border-ivory-200 bg-white p-4 text-sm" data-testid="identity-ip-pins">
      <p className={done.complete ? "font-semibold text-emerald-800" : "font-semibold text-amber-800"} data-testid="identity-staff-completion">{done.complete ? "Identity: Completed" : `Identity: still needed — ${done.missing.join("; ")}`}</p>
      <p className="mt-2 text-xs text-slate-600">IRS Identity Protection PIN (optional — only if the IRS issued one; then required to e-file). A new PIN each year. <a className="underline" href={IRS_IP_PIN_URL} target="_blank" rel="noopener noreferrer">IRS: Get an IP PIN</a></p>
      <ul className="mt-2 divide-y divide-ivory-200">
        {people.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="min-w-40 font-semibold text-navy-900">{p.name}</span>
            <ActionForm action={staffIpPinFlagAction.bind(null, clientId, p.id)} className="flex items-center gap-1" showSuccess={false}>
              <select className="input w-auto py-1 text-xs" name="has" defaultValue={p.hasIpPin ? "yes" : "no"} aria-label={`Does ${p.name} have an IP PIN?`}><option value="no">No IP PIN</option><option value="yes">Has an IP PIN</option></select>
              <button type="submit" className="text-xs underline">Save</button>
            </ActionForm>
            {p.hasIpPin && (
              <>
                <span className="text-xs text-slate-600">{pins.onFile.has(p.id) ? `${pins.year} PIN on file` : `${pins.year} PIN needed`}</span>
                {pins.onFile.has(p.id) && (
                  <ActionForm action={staffIpPinRevealAction.bind(null, clientId, p.id)} showSuccess>
                    <button type="submit" className="text-xs font-semibold underline" data-testid="ip-pin-reveal">View PIN (logged)</button>
                  </ActionForm>
                )}
                <ActionForm action={staffIpPinSaveAction.bind(null, clientId, p.id)} className="flex items-center gap-1" resetOnSuccess>
                  <input className="input w-24 py-1 text-xs" name="pin" inputMode="numeric" autoComplete="off" maxLength={6} placeholder={`${pins.year} PIN`} aria-label={`${p.name}'s ${pins.year} IP PIN`} required />
                  <button type="submit" className="text-xs font-semibold underline">{pins.onFile.has(p.id) ? "Replace" : "Add"}</button>
                </ActionForm>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
