import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, Notice, PageHeader } from "@/components/ui";
import { activationStepAction, reviewStepAction } from "@/app/actions/signup";
import { requireUser } from "@/lib/auth/session";
import { reviewQueue } from "@/lib/services/client-signup";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Portal sign-ups" };

export default async function OnboardingReviewPage() {
  await requireUser();
  const { applications, activations, clients } = await reviewQueue();
  return (
    <>
      <PageHeader title="Portal sign-ups to review" subtitle="New sign-ups that might match an existing client, and activation requests we couldn't match automatically." />
      <div className="mb-4">
        <Notice>
          Never connect a login to an existing client just because the email or name matches. Verify the person first (for example, call the phone number already on file), then
          connect — or send an activation link to the email already on the client&apos;s record.
        </Notice>
      </div>
      <div className="space-y-4">
        <Card title={`Possible existing clients (${applications.length})`}>
          {applications.length === 0 ? <EmptyState title="Nothing to review" /> : (
            <ul className="divide-y divide-navy-100">
              {applications.map((a) => (
                <li key={a.id} className="py-4" data-application={a.portalUser.email}>
                  <p className="font-semibold">
                    {a.clientType === "INDIVIDUAL" ? `${a.firstName} ${a.lastName}` : a.businessName} <span className="font-normal text-slate-600">· signed up as {a.portalUser.email} · {fmtDateTime(a.submittedAt)}</span>
                  </p>
                  <p className="text-sm text-slate-700">Phone {a.phone ?? "—"} · {[a.city, a.state].filter(Boolean).join(", ") || "no address"} · wants {a.servicesRequested.join(", ")} · {a.files.length} document(s)</p>
                  <p className="mt-2 text-sm font-semibold">Possible matches on file:</p>
                  <ul className="text-sm">
                    {a.possibleMatchIds.map((id) => {
                      const c = clients.get(id);
                      return c ? <li key={id}><Link className="underline" href={`/clients/${id}`}>{c.displayName}</Link> · {c.email ?? "no email"} · {c.phone ?? "no phone"}</li> : null;
                    })}
                  </ul>
                  <div className="mt-3 grid gap-3 lg:grid-cols-3">
                    <ActionForm action={reviewStepAction.bind(null, a.id, "link")} className="space-y-2 rounded-lg bg-navy-50 p-3">
                      <Field label="Connect to existing client">
                        <select className="input" name="clientId" required>
                          {a.possibleMatchIds.map((id) => <option key={id} value={id}>{clients.get(id)?.displayName ?? id}</option>)}
                        </select>
                      </Field>
                      <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="identityVerified" className="mt-1" /> I verified this person&apos;s identity</label>
                      <Button type="submit" variant="secondary">Connect</Button>
                    </ActionForm>
                    <ActionForm action={reviewStepAction.bind(null, a.id, "new")} className="rounded-lg bg-navy-50 p-3" confirm="Create a separate new client record? Only do this if they aren't any of the matches.">
                      <p className="mb-2 text-sm">Not any of these? Create a new client record.</p>
                      <Button type="submit" variant="secondary">Create new client</Button>
                    </ActionForm>
                    <ActionForm action={reviewStepAction.bind(null, a.id, "decline")} className="space-y-2 rounded-lg bg-navy-50 p-3">
                      <input className="input" name="note" placeholder="Reason (staff only)" aria-label="Decline reason" />
                      <Button type="submit" variant="ghost">Decline</Button>
                    </ActionForm>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={`Activation requests (${activations.length})`}>
          {activations.length === 0 ? <EmptyState title="Nothing to review" /> : (
            <ul className="divide-y divide-navy-100">
              {activations.map((r) => (
                <li key={r.id} className="py-3">
                  <p className="font-semibold">{r.name ?? "No name given"} <span className="font-normal text-slate-600">· {r.emailNormalized} · {r.phone ?? "no phone"} · {fmtDateTime(r.createdAt)}</span> {r.status === "EMAIL_FAILED" && <Badge tone="red">Email failed</Badge>}</p>
                  <p className="text-sm text-slate-700">{r.matchedClientIds.length === 0 ? "No client has this email on file." : `${r.matchedClientIds.length} record(s) have this email on file.`}</p>
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <ActionForm action={activationStepAction.bind(null, r.id, "send")} className="flex flex-wrap items-end gap-2">
                      <Field label="Send activation link to the email on file for">
                        <input className="input" name="clientId" list={`clients-${r.id}`} placeholder="Client ID" required defaultValue={r.matchedClientIds[0] ?? ""} />
                      </Field>
                      <datalist id={`clients-${r.id}`}>{r.matchedClientIds.map((id) => <option key={id} value={id}>{clients.get(id)?.displayName}</option>)}</datalist>
                      <Button type="submit" variant="secondary">Send link</Button>
                    </ActionForm>
                    <ActionForm action={activationStepAction.bind(null, r.id, "dismiss")}><Button variant="ghost">Dismiss</Button></ActionForm>
                  </div>
                  <p className="mt-1 text-xs text-slate-600">No match? Find the client, confirm the email on their record, and use their ID here (or invite them from the client&apos;s Portal tab).</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
