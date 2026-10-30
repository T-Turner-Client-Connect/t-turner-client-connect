import { BadgeCheck, Clock, IdCard, ShieldCheck, UserRound } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Field } from "@/components/ui";
import { portalAddPersonAction, portalIdentityUploadAction, rejectIdentityAction, staffAddPersonAction, staffIdentityUploadAction, verifyIdentityAction } from "@/app/actions/identity";
import { ID_ROLES, ID_STATUS, ID_TYPES, isAdminOnlyType, maskedSsn, type identityOverview, type IdRole, type IdType } from "@/lib/services/identity";
import { fmtIso } from "@/lib/tax/deadlines";
import { fmtDateTime } from "@/lib/format";

type Overview = Awaited<ReturnType<typeof identityOverview>>;
type Slot = Overview[number]["slots"][number];
type Rec = Slot["history"][number];

const TONE: Record<string, "green" | "amber" | "red" | "gray"> = { VERIFIED: "green", PENDING_VERIFICATION: "amber", REJECTED: "red", REPLACED: "gray", EXPIRED: "red" };

function detail(r: Rec, mode: "portal" | "staff" = "staff") {
  if (r.type === "DRIVERS_LICENSE") return r.expiresOn ? `Expires ${fmtIso(r.expiresOn, { month: "short", day: "numeric", year: "numeric" })}` : "";
  if (r.type === "SOCIAL_SECURITY_CARD") return mode === "portal" ? "On file with our office" : `${maskedSsn(r.last4)} · image contains the full number`;
  return "No expiration";
}

function UploadForm({ mode, clientId, personId, type, replacing }: { mode: "portal" | "staff"; clientId: string; personId: string; type: IdType; replacing: boolean }) {
  const t = ID_TYPES[type];
  const action = mode === "portal" ? portalIdentityUploadAction : staffIdentityUploadAction;
  return (
    <ActionForm action={action.bind(null, clientId)} className="mt-2 grid gap-2 rounded-xl bg-ivory-50 p-3 sm:grid-cols-2" resetOnSuccess idempotent>
      <input type="hidden" name="personId" value={personId} />
      <input type="hidden" name="type" value={type} />
      <Field label="File" hint="PDF, JPG or PNG. Front (and back for licenses) in one file if you can." className="sm:col-span-2"><input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required /></Field>
      {t.expires && <Field label="Expiration date on the license"><input className="input" type="date" name="expiresOn" required /></Field>}
      {replacing && (
        <Field label="Reason for the replacement">
          <select className="input" name="replacementReason" required defaultValue="">
            <option value="" disabled>Choose…</option>
            {t.replaceReasons.map((r) => <option key={r}>{r}</option>)}
          </select>
        </Field>
      )}
      <div className="sm:col-span-2"><Button type="submit" variant="gold">{replacing ? (type === "DRIVERS_LICENSE" ? "Upload Updated License" : "Upload replacement") : "Upload securely"}</Button></div>
      <p className="text-xs text-slate-600 sm:col-span-2">New uploads stay <strong>Pending Verification</strong> until our team reviews them.</p>
    </ActionForm>
  );
}

/**
 * Social Security cards (whose images show the full number) and birth
 * certificates are Admin-only. Admins open them after confirming and giving
 * a reason (audited); everyone else sees status only — no link is rendered,
 * and the server refuses direct file links.
 */
function ViewLink({ href, type, canOpen, mode }: { href: string; type: IdType; canOpen: boolean; mode: "portal" | "staff" }) {
  if (!canOpen) {
    return (
      <span className="text-xs text-slate-500" data-no-view>
        {mode === "portal" ? "Kept securely by our office — not viewable in the portal" : "Admin only"}
      </span>
    );
  }
  if (!isAdminOnlyType(type)) return <a className="text-sm font-semibold underline" href={href} target="_blank" rel="noopener">View</a>;
  return (
    <details className="text-sm" data-ss-view>
      <summary className="cursor-pointer font-semibold underline">Open (Admin)</summary>
      <form method="get" action={href} target="_blank" className="mt-1 space-y-1 rounded-lg border border-red-200 bg-red-50 p-2">
        <p className="text-xs text-red-900">
          {type === "SOCIAL_SECURITY_CARD" ? <>This image shows the <strong>full Social Security number</strong>.</> : <>Birth certificates are Admin-only.</>} Every opening is logged with your reason.
        </p>
        <input type="hidden" name="confirm" value="1" />
        <select className="input text-xs" name="purpose" required defaultValue="">
          <option value="" disabled>Reason…</option>
          <option>Preparing a tax return</option>
          <option>Verifying the document</option>
          <option>Client request</option>
          <option>Agency correspondence</option>
        </select>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="download" value="1" /> Download instead of view</label>
        <button type="submit" className="rounded-md bg-navy-900 px-3 py-1 text-xs font-semibold text-white">Open</button>
      </form>
    </details>
  );
}

function SlotRow({ slot, mode, clientId, personId, linkFor, readOnly, viewerIsAdmin }: { slot: Slot; mode: "portal" | "staff"; clientId: string; personId: string; linkFor: (documentId: string) => string; readOnly?: boolean; viewerIsAdmin?: boolean }) {
  const canOpen = mode === "portal" ? !isAdminOnlyType(slot.type) : !!viewerIsAdmin || !isAdminOnlyType(slot.type);
  const t = ID_TYPES[slot.type];
  const { current, pending } = slot;
  const has = !!(current || pending.length);
  const status = current?.status ?? (pending.length ? "PENDING_VERIFICATION" : null);
  return (
    <li className="py-3" data-id-slot={slot.type}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-navy-900">{t.label}</p>
          {current ? (
            <p className="text-sm text-slate-700">
              {detail(current, mode)}
              {current.status === "VERIFIED" && slot.daysLeft !== null && slot.daysLeft <= 60 && <span className="ml-1 font-semibold text-amber-800">· {slot.daysLeft} days left</span>}
              {current.verifiedAt && <span className="block text-xs text-slate-500">Current verified document · verified {fmtDateTime(current.verifiedAt)}</span>}
            </p>
          ) : (
            <p className="text-sm text-slate-600">{pending.length ? "Received — our team will verify it." : "Not on file."}</p>
          )}
        </div>
        <span className="flex flex-wrap items-center gap-2">
          {status && <Badge tone={TONE[status]}>{status === "VERIFIED" ? "✓ Verified" : ID_STATUS[status as keyof typeof ID_STATUS]}</Badge>}
          {current && !readOnly && <ViewLink href={canOpen ? linkFor(current.documentId) : ""} type={slot.type} canOpen={canOpen} mode={mode} />}
        </span>
      </div>

      {pending.map((p) => (
        <div key={p.id} className="mt-2 rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-sm" data-pending={p.id}>
          <div className="flex flex-wrap items-center gap-2">
            <Clock className="size-4 text-amber-700" aria-hidden />
            <strong>Pending verification</strong> · uploaded {fmtDateTime(p.createdAt)}{p.replacementReason && ` · ${p.replacementReason}`}{p.type === "DRIVERS_LICENSE" && p.expiresOn && ` · expires ${fmtIso(p.expiresOn, { month: "short", day: "numeric", year: "numeric" })}`}
            {!readOnly && <ViewLink href={canOpen ? linkFor(p.documentId) : ""} type={p.type as IdType} canOpen={canOpen} mode={mode} />}
          </div>
          {mode === "staff" && !readOnly && !canOpen && <p className="mt-1 text-xs text-slate-600">An Admin reviews this document.</p>}
          {mode === "staff" && !readOnly && canOpen && (
            <div className="mt-2 grid gap-2 lg:grid-cols-2">
              <ActionForm action={verifyIdentityAction.bind(null, clientId, p.id)} className="flex flex-wrap items-end gap-2">
                {p.type === "DRIVERS_LICENSE" && <Field label="Confirm expiration"><input className="input" type="date" name="expiresOn" defaultValue={p.expiresOn ?? ""} required /></Field>}
                {p.type === "SOCIAL_SECURITY_CARD" && <Field label="Last 4 digits (optional)" hint="Never the full number."><input className="input w-24" name="last4" inputMode="numeric" maxLength={4} pattern="\d{4}" autoComplete="off" /></Field>}
                <Button type="submit"><BadgeCheck className="mr-1 inline size-4" aria-hidden />Verify</Button>
              </ActionForm>
              <ActionForm action={rejectIdentityAction.bind(null, clientId, p.id)} className="flex flex-wrap items-end gap-2">
                <Field label="Decline — reason for the client"><input className="input" name="reason" placeholder="e.g. Image is blurry" required /></Field>
                <Button type="submit" variant="ghost">Decline</Button>
              </ActionForm>
            </div>
          )}
        </div>
      ))}
      {slot.rejected && <p className="mt-2 text-sm text-red-800">Not accepted: {slot.rejected.rejectedReason} Please upload a new copy.</p>}

      {!readOnly && (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm font-semibold text-gold-700 underline">
            {has ? (slot.type === "DRIVERS_LICENSE" ? "Upload Updated License" : "Replace this document") : `Upload ${t.label.toLowerCase()}`}
          </summary>
          <UploadForm mode={mode} clientId={clientId} personId={personId} type={slot.type} replacing={has} />
        </details>
      )}

      {slot.history.length > 1 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-slate-600 underline">History ({slot.history.length})</summary>
          <ul className="mt-1 space-y-1 text-xs text-slate-600">
            {slot.history.map((h) => (
              <li key={h.id}>
                {fmtDateTime(h.createdAt)} · <Badge tone={TONE[h.status]}>{ID_STATUS[h.status as keyof typeof ID_STATUS]}</Badge> {detail(h, mode)}{h.replacementReason && ` · ${h.replacementReason}`}{h.rejectedReason && ` · ${h.rejectedReason}`}
                {h.id === current?.id && <strong> · current</strong>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/** Identity Documents for one client: the client, spouse and each dependent. */
export function IdentitySection({ overview, mode, clientId, linkFor, readOnly, viewerIsAdmin }: { overview: Overview; mode: "portal" | "staff"; clientId: string; linkFor: (documentId: string) => string; readOnly?: boolean; viewerIsAdmin?: boolean }) {
  const hasSpouse = overview.some((o) => o.person.role === "SPOUSE");
  return (
    <div className="space-y-4" data-testid="identity-section">
      <p className="flex items-start gap-2 rounded-xl border border-ivory-200 bg-white p-3 text-sm text-slate-700">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-gold-600" aria-hidden />
        Permanent records, kept separate from yearly tax folders and reused every tax year — no need to upload them again each year. Every file is malware-scanned, encrypted before storage, and each view is logged. Social Security cards (their images show the full number) and birth certificates are viewable only by an Admin — never in the client portal.
      </p>
      {overview.map(({ person, slots }) => (
        <section key={person.id} className="rounded-2xl border border-ivory-200 bg-white p-4 shadow-sm sm:p-5" data-person={person.role}>
          <h3 className="mb-1 flex items-center gap-2 font-serif text-lg font-bold text-navy-900">
            {person.role === "CLIENT" ? <IdCard className="size-5 text-gold-600" aria-hidden /> : <UserRound className="size-5 text-gold-600" aria-hidden />}
            {person.name} <span className="text-sm font-normal text-slate-500">· {ID_ROLES[person.role as IdRole]}</span>
          </h3>
          <ul className="divide-y divide-navy-100">
            {slots.map((s) => <SlotRow key={s.type} slot={s} mode={mode} clientId={clientId} personId={person.id} linkFor={linkFor} readOnly={readOnly} viewerIsAdmin={viewerIsAdmin} />)}
          </ul>
        </section>
      ))}
      {!readOnly && (
        <details className="rounded-2xl border border-dashed border-gold-500 bg-white/70 p-4">
          <summary className="cursor-pointer font-semibold text-navy-900">Add a spouse or dependent</summary>
          <ActionForm action={(mode === "portal" ? portalAddPersonAction : staffAddPersonAction).bind(null, clientId)} className="mt-2 flex flex-wrap items-end gap-2" resetOnSuccess>
            <Field label="Relationship">
              <select className="input" name="role" defaultValue={hasSpouse ? "DEPENDENT" : "SPOUSE"}>
                {!hasSpouse && <option value="SPOUSE">Spouse</option>}
                <option value="DEPENDENT">Dependent</option>
              </select>
            </Field>
            <Field label="Full name"><input className="input" name="name" required /></Field>
            <Button type="submit" variant="secondary">Add</Button>
          </ActionForm>
        </details>
      )}
    </div>
  );
}
