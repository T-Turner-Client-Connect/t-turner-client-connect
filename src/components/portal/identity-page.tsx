import { Car, ChevronDown, IdCard, Lightbulb, ShieldCheck, Trash2, UserPlus, UserRound, Users } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { SlotRow } from "@/components/identity-section";
import { portalAddPersonAction, portalRemovePersonAction } from "@/app/actions/identity";
import { ID_ROLES, ID_TYPES, type identityOverview, type IdRole, type IdType } from "@/lib/services/identity";
import { fmtIso } from "@/lib/tax/deadlines";
import { NavyCard } from "./luxury";

type Overview = Awaited<ReturnType<typeof identityOverview>>;
type Entry = Overview[number];
type Slot = Entry["slots"][number];

const CHIP = {
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  amber: "bg-amber-50 text-amber-900 ring-amber-200",
  red: "bg-red-50 text-red-800 ring-red-200",
  gray: "bg-slate-50 text-slate-600 ring-slate-200",
} as const;

/** One document's status, worded for clients. An expired license always says Expired, even while a renewal is pending. */
function slotStatus(s: Slot): { text: string; tone: keyof typeof CHIP; note?: string } {
  const exp = s.current?.type === "DRIVERS_LICENSE" && s.current.expiresOn ? fmtIso(s.current.expiresOn, { month: "short", day: "numeric", year: "numeric" }) : null;
  if (s.current?.status === "EXPIRED") return { text: "Expired", tone: "red", note: s.pending.length ? "Renewal received — pending verification" : exp ? `Expired ${exp}` : undefined };
  if (s.current?.status === "VERIFIED") {
    const soon = s.daysLeft !== null && s.daysLeft <= 60;
    return { text: "✓ Verified", tone: soon ? "amber" : "green", note: soon ? `${s.daysLeft} days left${s.pending.length ? " · renewal pending" : ""}` : exp ? `Expires ${exp}` : undefined };
  }
  if (s.pending.length) return { text: "Pending verification", tone: "amber" };
  if (s.rejected) return { text: "Not accepted", tone: "red", note: "Please upload a new copy" };
  return { text: "Not on file", tone: "gray" };
}

function StatusChip({ s, label }: { s: Slot; label?: boolean }) {
  const st = slotStatus(s);
  return (
    <span className="block min-w-0" data-id-status={s.type} data-status={st.text}>
      {label && <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{ID_TYPES[s.type].label}</span>}
      <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold ring-1 ${CHIP[st.tone]}`}>{st.text}</span>
      {st.note && <span className="mt-1 block text-xs text-slate-600">{st.note}</span>}
    </span>
  );
}

const slotOf = (e: Entry, t: IdType) => e.slots.find((s) => s.type === t)!;

/** Anything already submitted for this person (any document, any status). */
const hasSubmitted = (e: Entry) => e.slots.some((s) => s.history.length > 0);

/**
 * A spouse or dependent added by mistake can be removed until something is submitted for
 * them; after that only our office can remove them (the server enforces this too).
 */
function RemovePerson({ entry, clientId }: { entry: Entry; clientId: string }) {
  if (entry.person.role === "CLIENT" || entry.person.role === "OWNER") return null;
  if (hasSubmitted(entry)) return <p className="px-4 pb-3 text-xs text-slate-500 sm:px-6">Documents were submitted for {entry.person.name}. To remove them, please send our office a message.</p>;
  return (
    <ActionForm action={portalRemovePersonAction.bind(null, clientId, entry.person.id)} className="px-4 pb-3 sm:px-6">
      <button type="submit" className="inline-flex items-center gap-1.5 text-sm font-semibold text-red-700 underline-offset-2 hover:underline" data-testid="remove-person">
        <Trash2 className="size-4" aria-hidden /> Remove {entry.person.name}
      </button>
      <span className="ml-2 text-xs text-slate-500">Added by mistake? You can remove them until documents are submitted.</span>
    </ActionForm>
  );
}

function Slots({ entry, clientId, linkFor }: { entry: Entry; clientId: string; linkFor: (id: string) => string }) {
  // Dependents: a driver's license only for those old enough to drive — never asked by default.
  const isDependent = entry.person.role === "DEPENDENT";
  const license = entry.slots.find((s) => s.type === "DRIVERS_LICENSE");
  const showLicense = !isDependent || (license?.history.length ?? 0) > 0;
  return (
    <div className="border-t border-ivory-200 bg-ivory-50/40">
      <ul className="divide-y divide-navy-100 px-4 sm:px-6">
        {entry.slots.filter((s) => showLicense || s.type !== "DRIVERS_LICENSE").map((s) => <SlotRow key={s.type} slot={s} mode="portal" clientId={clientId} personId={entry.person.id} linkFor={linkFor} />)}
      </ul>
      {!showLicense && license && (
        <details className="px-4 pb-3 sm:px-6">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-semibold text-navy-900 underline underline-offset-2 [&::-webkit-details-marker]:hidden"><Car className="size-4 text-gold-600" aria-hidden />Only if {entry.person.name} drives: add a driver&apos;s license</summary>
          <ul className="mt-1"><SlotRow slot={license} mode="portal" clientId={clientId} personId={entry.person.id} linkFor={linkFor} /></ul>
        </details>
      )}
      <RemovePerson entry={entry} clientId={clientId} />
    </div>
  );
}

const updateBtn = "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-gradient-to-b from-navy-900 to-navy-950 px-5 py-2.5 text-sm font-semibold text-white shadow group-open:from-gold-500 group-open:to-gold-600 group-open:text-navy-950";

/** Client or spouse: navy name block, three document statuses, Update Documents. */
function PersonRow({ entry, clientId, linkFor }: { entry: Entry; clientId: string; linkFor: (id: string) => string }) {
  return (
    <details className="group overflow-hidden rounded-2xl border border-ivory-200 bg-white shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)]" data-person={entry.person.role}>
      <summary className="grid cursor-pointer list-none gap-4 p-3 sm:p-4 md:grid-cols-[15rem_1fr_auto] md:items-center [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-3 rounded-xl bg-gradient-to-br from-navy-900 to-navy-950 px-4 py-4 text-white ring-1 ring-gold-500/40">
          {entry.person.role === "CLIENT" ? <IdCard className="size-8 shrink-0 text-gold-400" aria-hidden /> : <UserRound className="size-8 shrink-0 text-gold-400" aria-hidden />}
          <span className="min-w-0">
            <span className="block font-serif text-lg font-bold leading-tight text-white [overflow-wrap:anywhere]">{entry.person.name}</span>
            <span className="block text-sm text-gold-300">{entry.person.role === "CLIENT" || entry.person.role === "OWNER" ? "You" : ID_ROLES[entry.person.role as IdRole]}</span>
          </span>
        </span>
        <span className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {(["DRIVERS_LICENSE", "BIRTH_CERTIFICATE", "SOCIAL_SECURITY_CARD"] as const).map((t) => <StatusChip key={t} s={slotOf(entry, t)} label />)}
        </span>
        <span className={updateBtn}>Update Documents <ChevronDown className="size-4 transition group-open:rotate-180" aria-hidden /></span>
      </summary>
      <Slots entry={entry} clientId={clientId} linkFor={linkFor} />
    </details>
  );
}

function AddPerson({ clientId, role, label }: { clientId: string; role: "SPOUSE" | "DEPENDENT"; label: string }) {
  return (
    <ActionForm action={portalAddPersonAction.bind(null, clientId)} className="flex flex-wrap items-end gap-3" resetOnSuccess>
      <input type="hidden" name="role" value={role} />
      <label className="block min-w-0 flex-1">
        <span className="mb-1 block text-sm font-semibold text-navy-900">{label}</span>
        <input className="input" name="name" required placeholder="Full name" />
      </label>
      <button type="submit" className="inline-flex items-center gap-2 rounded-xl border-2 border-gold-500 bg-gradient-to-b from-white to-gold-50 px-5 py-2 font-semibold text-navy-900 hover:to-gold-100">
        <UserPlus className="size-4" aria-hidden /> {role === "SPOUSE" ? "Add Spouse" : "Add a Dependent"}
      </button>
    </ActionForm>
  );
}

/**
 * Identity Documents, built to Tabitha's design. Every upload, replacement, expiration and
 * verification rule is the same as before (the per-document rows come from the shared
 * Identity section); Social Security cards and birth certificates stay status-only here.
 */
/** `ownerOnly`: a business owner's own record on a business-only account (no spouse or dependents). */
export function IdentityPageView({ overview, clientId, linkFor, ownerOnly = false }: { overview: Overview; clientId: string; linkFor: (id: string) => string; ownerOnly?: boolean }) {
  const client = overview.find((o) => o.person.role === "CLIENT");
  const spouse = overview.find((o) => o.person.role === "SPOUSE");
  const dependents = overview.filter((o) => o.person.role === "DEPENDENT");
  const cols = "md:grid-cols-[1.4fr_1fr_1fr_auto]";
  return (
    <div className="space-y-6" data-testid="identity-section">
      <section className="flex items-start gap-4 rounded-2xl bg-gradient-to-r from-navy-950 via-navy-900 to-navy-800 px-5 py-4 text-white ring-1 ring-gold-500/40 sm:items-center sm:px-7" data-testid="secure-strip">
        <ShieldCheck className="size-10 shrink-0 text-gold-400" aria-hidden />
        <div className="min-w-0">
          <p className="font-serif text-xl font-bold text-white">Secure &amp; Permanent Records</p>
          <p className="text-sm text-navy-100">Kept separate from yearly tax folders and reused every tax year. Every file is malware-scanned, encrypted before storage, and each view is logged. Social Security cards and birth certificates are viewable only by an Admin — never in the client portal.</p>
        </div>
      </section>

      {ownerOnly && overview.map((o) => <PersonRow key={o.person.id} entry={o} clientId={clientId} linkFor={linkFor} />)}
      {!ownerOnly && client && <PersonRow entry={client} clientId={clientId} linkFor={linkFor} />}
      {ownerOnly ? null : spouse ? (
        <PersonRow entry={spouse} clientId={clientId} linkFor={linkFor} />
      ) : (
        <div className="grid gap-4 rounded-2xl border border-dashed border-gold-400 bg-white p-3 sm:p-4 md:grid-cols-[15rem_1fr] md:items-center" data-person="SPOUSE" data-empty>
          <span className="flex items-center gap-3 rounded-xl bg-navy-900/90 px-4 py-4 text-white">
            <UserRound className="size-8 shrink-0 text-gold-400" aria-hidden />
            <span><span className="block font-serif text-lg font-bold text-white">Spouse</span><span className="block text-sm text-gold-300">Not listed</span></span>
          </span>
          <AddPerson clientId={clientId} role="SPOUSE" label="Add your spouse to upload their documents" />
        </div>
      )}

      {!ownerOnly && (
      <NavyCard icon={Users} title="Dependents">
        <div role="table" aria-label="Dependents" className="text-sm">
          <div role="row" className={`hidden gap-4 border-b border-ivory-200 px-3 pb-2 font-semibold text-navy-900 md:grid ${cols}`}>
            <span role="columnheader">Name</span>
            <span role="columnheader">Birth Certificate</span>
            <span role="columnheader">SS Card</span>
            <span role="columnheader" className="text-right">Actions</span>
          </div>
          {dependents.length === 0 && <p className="px-3 py-5 text-slate-600">No dependents listed yet.</p>}
          {dependents.map((d) => (
            <details key={d.person.id} className="group border-b border-ivory-200 last:border-0" data-person="DEPENDENT">
              <summary role="row" className={`grid cursor-pointer list-none items-center gap-3 px-3 py-3 md:gap-4 ${cols} [&::-webkit-details-marker]:hidden`}>
                <span role="cell" className="flex items-center gap-2 font-serif text-base font-bold text-navy-900 [overflow-wrap:anywhere]"><UserRound className="size-5 shrink-0 text-gold-600" aria-hidden />{d.person.name}</span>
                <span role="cell"><span className="mr-2 text-xs font-semibold text-slate-500 md:hidden">Birth Certificate</span><StatusChip s={slotOf(d, "BIRTH_CERTIFICATE")} /></span>
                <span role="cell"><span className="mr-2 text-xs font-semibold text-slate-500 md:hidden">SS Card</span><StatusChip s={slotOf(d, "SOCIAL_SECURITY_CARD")} /></span>
                <span role="cell" className="md:text-right"><span className={updateBtn}>Update <ChevronDown className="size-4 transition group-open:rotate-180" aria-hidden /></span></span>
              </summary>
              <Slots entry={d} clientId={clientId} linkFor={linkFor} />
            </details>
          ))}
        </div>
        <div className="mt-4 rounded-xl border border-dashed border-gold-400 bg-gold-50/40 p-3 sm:p-4">
          <AddPerson clientId={clientId} role="DEPENDENT" label="Add a Dependent" />
        </div>
      </NavyCard>
      )}

      <NavyCard icon={Lightbulb} title="Helpful Reminders">
        <ul className="list-disc space-y-1.5 pl-5 text-[15px] text-navy-800" data-testid="identity-reminders">
          <li>Upload your renewed driver&apos;s license before it expires — we remind you 60, 30 and 7 days ahead.</li>
          <li>New uploads stay <strong>Pending Verification</strong> until our team reviews them.</li>
          <li>Social Security cards and birth certificates are kept securely by our office and can&apos;t be viewed or downloaded in the portal.</li>
          <li>These records are permanent — no need to upload them again each tax year.</li>
        </ul>
      </NavyCard>
    </div>
  );
}
