import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice } from "@/components/ui";
import { staffCommPrefsAction } from "@/app/actions/clients";
import { CATEGORY_TEXT, SOURCE_TEXT, preferenceHistory, preferenceState } from "@/lib/services/comm-prefs";
import { fmtDateTime } from "@/lib/format";

const On = ({ on }: { on: boolean }) => <Badge tone={on ? "green" : "gray"}>{on ? "Subscribed" : "Off"}</Badge>;

/**
 * Staff view of the client's Communication Preferences (what the client chose
 * in the portal, by email link or by text reply) with the full history.
 * Staff changes are only for a client's own request, and are logged with a note.
 */
export async function CommPrefsStaffCard({ clientId, people }: { clientId: string; people: { id: string | null; name: string }[] }) {
  const [states, history] = await Promise.all([
    Promise.all(people.map((p) => preferenceState([{ clientId, contactId: p.id }]))),
    preferenceHistory(clientId),
  ]);
  const blocked = states.some((s) => s.smsBlocked);
  return (
    <Card title="Communication Preferences">
      <p className="mb-3 text-sm text-slate-600">
        The client&apos;s choices for optional messages. Every campaign, flyer, newsletter and announcement checks these right before sending. Essential messages (appointments,
        billing, security codes, tax document requests) are not affected.
      </p>
      {blocked && (
        <div className="mb-3" data-testid="staff-sms-blocked">
          <Notice tone="warn" title="Texts blocked (replied STOP)">
            Every text to this number is blocked — appointment, billing and security texts included — because the client replied STOP. Use email or the portal. Texts resume only if the client replies START.
          </Notice>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm" data-testid="staff-comm-prefs">
          <thead>
            <tr className="text-left text-slate-600">
              <th className="py-2 pr-3 font-semibold">Person</th>
              <th className="py-2 pr-3 font-semibold">{CATEGORY_TEXT.PROMO_SMS}</th>
              <th className="py-2 pr-3 font-semibold">{CATEGORY_TEXT.PROMO_EMAIL}</th>
              <th className="py-2 pr-3 font-semibold">{CATEGORY_TEXT.GENERAL_UPDATES}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-navy-100">
            {people.map((p, i) => (
              <tr key={p.id ?? "primary"}>
                <td className="py-2 pr-3 font-medium">{p.name}</td>
                <td className="py-2 pr-3">{states[i].smsBlocked ? <Badge tone="red">Blocked (STOP)</Badge> : <On on={states[i].promoSms} />}</td>
                <td className="py-2 pr-3">{states[i].emailBlocked ? <Badge tone="red">{states[i].emailBlocked}</Badge> : <On on={states[i].promoEmail} />}</td>
                <td className="py-2 pr-3"><On on={states[i].generalUpdates} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-semibold text-navy-800 underline">Update at the client&apos;s request</summary>
        <ActionForm action={staffCommPrefsAction.bind(null, clientId)} className="mt-3 grid gap-3 sm:grid-cols-2" resetOnSuccess>
          <Field label="Person">
            <select className="input" name="contactId">
              {people.map((p) => <option key={p.id ?? "primary"} value={p.id ?? ""}>{p.name}</option>)}
            </select>
          </Field>
          {(["promoSms", "promoEmail", "generalUpdates"] as const).map((k) => (
            <Field key={k} label={CATEGORY_TEXT[k === "promoSms" ? "PROMO_SMS" : k === "promoEmail" ? "PROMO_EMAIL" : "GENERAL_UPDATES"]}>
              <select className="input" name={k} defaultValue="">
                <option value="">No change</option>
                <option value="on">Subscribe</option>
                <option value="off">Unsubscribe</option>
              </select>
            </Field>
          ))}
          <Field label="How did the client ask?" className="sm:col-span-2" hint="Required. Saved in the history, e.g. “Phone call with the client, 11/4”. Turning on promotional texts records the client's agreement to the marketing text wording.">
            <input className="input" name="note" required maxLength={500} />
          </Field>
          <div className="sm:col-span-2"><Button type="submit">Save on the client&apos;s behalf</Button></div>
        </ActionForm>
      </details>

      <details className="mt-4" open={history.length > 0 && history.length <= 5}>
        <summary className="cursor-pointer text-sm font-semibold text-navy-800 underline">Preference history ({history.length})</summary>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No changes yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-navy-100 text-sm" data-testid="comm-pref-history">
            {history.map((h) => (
              <li key={h.id} className="py-2">
                <p>
                  <strong>{CATEGORY_TEXT[h.category]}</strong> → {h.subscribed ? "subscribed" : "unsubscribed"}
                  {h.contactName && <> · {h.contactName}</>}
                </p>
                <p className="text-slate-600">
                  {fmtDateTime(h.createdAt)} · {SOURCE_TEXT[h.source] ?? h.source}
                  {h.actorName && <> · by {h.actorName}</>}
                  {h.note && <> · {h.note}</>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </details>
    </Card>
  );
}
