import { ExternalLink, KeyRound } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { NavyCard } from "./luxury";
import { IRS_IP_PIN_URL } from "@/lib/services/identity";

type Person = { id: string; name: string; hasIpPin: boolean };
type FormAction = (prev: never, fd: FormData) => Promise<unknown>;

/**
 * Optional: an IRS Identity Protection PIN, only for people the IRS issued one to (it's then
 * required to e-file their return). A new PIN every year; once saved it's never shown here again.
 */
export function IpPinCard({ people, year, onFile, flagAction, saveAction }: { people: Person[]; year: number; onFile: Set<string>; flagAction: (personId: string) => FormAction; saveAction: (personId: string) => FormAction; readOnly?: boolean }) {
  if (!people.length) return null;
  return (
    <NavyCard icon={KeyRound} title="IRS Identity Protection PIN (optional)">
      <p className="text-sm text-navy-800" data-testid="ip-pin-note">Only if the IRS issued you an IP PIN — it&apos;s then required to e-file your return. The IRS sends a new one every year: sign in with ID.me to get this year&apos;s PIN, then add it here.</p>
      <a href={IRS_IP_PIN_URL} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-800" data-testid="ip-pin-irs-link">Get your IP PIN from the IRS <ExternalLink className="size-4" aria-hidden /></a>
      <ul className="mt-3 divide-y divide-ivory-200 text-sm">
        {people.map((p) => (
          <li key={p.id} className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:justify-between" data-ip-pin={p.id}>
            <span className="font-semibold text-navy-900">{p.name}{p.hasIpPin ? <span className="ml-2 font-normal text-slate-600">{onFile.has(p.id) ? `${year} IP PIN on file` : `${year} IP PIN needed`}</span> : null}</span>
            {/* View as Client shows the same controls; its actions are the preview's stand-ins. */}
            {(
              <div className="flex flex-wrap items-center gap-2">
                <ActionForm action={flagAction(p.id) as never} className="flex items-center gap-2" showSuccess={false}>
                  <select className="input w-auto py-1 text-sm" name="has" defaultValue={p.hasIpPin ? "yes" : "no"} aria-label={`Does ${p.name} have an IP PIN?`}>
                    <option value="no">No IP PIN</option>
                    <option value="yes">Has an IP PIN</option>
                  </select>
                  <button type="submit" className="text-sm font-semibold text-navy-900 underline">Save</button>
                </ActionForm>
                {p.hasIpPin && (
                  <ActionForm action={saveAction(p.id) as never} className="flex items-center gap-2" resetOnSuccess>
                    <input className="input w-28 py-1 text-sm" name="pin" inputMode="numeric" autoComplete="off" pattern="\d{6}" maxLength={6} placeholder={`${year} PIN`} aria-label={`${p.name}'s ${year} IP PIN`} required />
                    <button type="submit" className="rounded-lg bg-gold-400 px-3 py-1.5 text-sm font-semibold text-navy-950">{onFile.has(p.id) ? "Replace" : "Add"}</button>
                  </ActionForm>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </NavyCard>
  );
}
