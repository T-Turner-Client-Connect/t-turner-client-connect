import Link from "next/link";
import { notFound } from "next/navigation";
import clsx from "clsx";
import { Crown, History, Lock, ShieldCheck, Sparkles } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Notice, PageHeader } from "@/components/ui";
import { PermissionMatrix } from "@/components/owner/permission-matrix";
import { SettingsNav } from "@/components/owner/settings-nav";
import { applyPermissionPresetAction, saveStaffPermissionsAction } from "@/app/actions/owner";
import { requireOffice, staffAccessVisible } from "@/lib/auth/owner";
import { permissionHistory, staffAccessBoard } from "@/lib/auth/permissions";
import { ACTION_LABELS, AREAS, DARIA_PRESET, OWNER_GRANTS_ONLY, PRESETS, type PermAction, type PermKey } from "@/lib/permissions";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Staff Access & Permissions" };

const areaLabel = (a: string) => AREAS.find((x) => x.key === a)?.label ?? a;
const actionLabel = (a: string) => ACTION_LABELS[a as PermAction] ?? a;
const sourceLabel = (s: string) => {
  if (s.startsWith("preset:")) return PRESETS.find((p) => p.key === s.slice(7))?.label ?? "Preset";
  if (s.startsWith("migration:")) return "Carried over from earlier access";
  if (s === "legacy:bookkeeping_billing") return "Settings → Team billing toggle";
  if (s === "invite") return "Staff invitation";
  return "Edited on this screen";
};

export default async function StaffAccessPage({ searchParams }: { searchParams: Promise<{ user?: string }> }) {
  const { actor, access } = await requireOffice();
  if (!staffAccessVisible(access)) notFound();
  const sp = await searchParams;
  const { me, staff } = await staffAccessBoard(actor);
  const selected = staff.find((s) => s.id === sp.user) ?? staff.find((s) => !s.isOwner && s.id !== actor.id) ?? staff[0];
  const history = await permissionHistory(actor, { take: 40 });
  const canManage = me.isOwner || me.keys.has("staff.manage");
  const editable = !!selected && canManage && !selected.isOwner && selected.id !== actor.id;
  const held = new Set<string>(selected?.keys ?? []);
  const mayChange = (k: PermKey) => me.isOwner || (me.keys.has(k) && !OWNER_GRANTS_ONLY.includes(k));
  const first = selected?.name.split(" ")[0] ?? "";

  return (
    <>
      <PageHeader title="Settings" />
      <SettingsNav access={access} current="staff" />
      <div className="mb-5 rounded-2xl bg-navy-900 p-5 text-white sm:p-6">
        <p className="flex items-center gap-2 font-serif text-2xl font-bold"><ShieldCheck className="size-6 text-gold-500" aria-hidden /> Staff Access &amp; <em className="font-normal italic text-gold-300">Permissions</em></p>
        <p className="mt-2 max-w-3xl text-sm text-navy-100">
          Choose a staff member, then allow or deny each area of the Owner&apos;s Office. Changes apply on their next click — no sign-out needed — and every change is checked on the server and kept in the history below.
          Coetha prepares and recommends; only you approve her work.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <Card title="Staff">
          <ul className="space-y-1" data-testid="staff-list">
            {staff.map((s) => {
              const on = s.id === selected?.id;
              return (
                <li key={s.id}>
                  <Link
                    href={`/owner/settings/staff-access?user=${s.id}`}
                    aria-current={on ? "true" : undefined}
                    className={clsx("block rounded-xl border px-3 py-2.5 text-sm", on ? "border-gold-500 bg-gold-50" : "border-transparent hover:border-ivory-200 hover:bg-ivory-100")}
                  >
                    <span className="flex items-center gap-2 font-semibold text-navy-900">
                      {s.isOwner && <Crown className="size-4 text-gold-600" aria-hidden />}
                      {s.name}
                      {s.id === actor.id && <span className="text-xs font-normal text-slate-500">(you)</span>}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-600">
                      {s.isOwner ? "Owner — full access (permanent)" : s.keys.length ? `${s.keys.length} permission${s.keys.length === 1 ? "" : "s"}` : "No Owner's Office access"}
                      {" · "}{s.role === "ADMIN" ? "Admin" : "Staff"}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>

        {selected && (
          <div className="space-y-4">
            <Card
              title={<span className="flex flex-wrap items-center gap-2">{selected.name} {selected.isOwner ? <Badge tone="gold">Owner — full access (permanent)</Badge> : <Badge tone={selected.keys.length ? "navy" : "gray"}>{selected.keys.length} allowed</Badge>}</span>}
            >
              <p className="-mt-2 mb-4 text-sm text-slate-600">{selected.email}{!selected.twoStep && !selected.isOwner && " · two-step verification not set up yet (they can't sign in until they do)"}</p>

              {selected.isOwner ? (
                <div className="mb-4 flex items-start gap-3 rounded-xl border border-gold-300 bg-gold-50 p-4 text-sm text-navy-900" data-testid="owner-permanent">
                  <Crown className="mt-0.5 size-5 shrink-0 text-gold-600" aria-hidden />
                  <p><strong>Owner — full access (permanent).</strong> Tabitha holds every permission, including the ones that are hers alone (approving Coetha&apos;s work, closing books, approving reports, submitting and releasing returns). No one can edit, reduce or remove this, and no one else can be made Owner.</p>
                </div>
              ) : selected.id === actor.id ? (
                <Notice tone="info">You can&apos;t change your own permissions. Ask the owner.</Notice>
              ) : !canManage ? (
                <Notice tone="info">You can view permissions. Only the owner (or staff she allows to manage staff) can change them.</Notice>
              ) : null}

              {editable && (
                <div className="mb-4 rounded-xl border border-ivory-200 bg-ivory-100 p-3" data-testid="presets">
                  <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-navy-900"><Sparkles className="size-4 text-gold-600" aria-hidden /> Quick presets <span className="font-normal text-slate-600">— replaces {first}&apos;s permissions with the preset</span></p>
                  <div className="flex flex-wrap gap-2">
                    {PRESETS.map((p) => (
                      <ActionForm
                        key={p.key}
                        action={applyPermissionPresetAction.bind(null, selected.id, p.key)}
                        confirm={`Apply “${p.label}” to ${selected.name}? This replaces their current Owner's Office permissions. ${p.description}`}
                        showSuccess={false}
                      >
                        <Button type="submit" variant={p.key === DARIA_PRESET.key ? "gold" : "secondary"} title={p.description} data-preset={p.key} className="text-xs">{p.label}</Button>
                      </ActionForm>
                    ))}
                  </div>
                </div>
              )}

              {editable ? (
                <ActionForm
                  action={saveStaffPermissionsAction.bind(null, selected.id)}
                  confirm={`Save ${selected.name}'s permissions? Changes apply on their next click.`}
                  className="space-y-3"
                >
                  <PermissionMatrix held={held} mode={{ kind: "edit", mayChange }} />
                  <div className="flex flex-wrap items-center gap-3">
                    <Button type="submit" data-testid="save-permissions">Save permissions</Button>
                    <p className="text-xs text-slate-600">Most actions also need View to open their screen. † = nothing in Client Connect uses this yet. <Lock className="inline size-3" aria-hidden /> Owner-only actions can&apos;t be granted.</p>
                  </div>
                </ActionForm>
              ) : (
                <PermissionMatrix held={held} mode={selected.isOwner ? { kind: "owner" } : { kind: "readonly" }} />
              )}
            </Card>
          </div>
        )}
      </div>

      <Card className="mt-4" title={<span className="flex items-center gap-2"><History className="size-5 text-gold-600" aria-hidden /> Change history</span>}>
        {history.length === 0 ? (
          <p className="text-sm text-slate-600">No permission changes yet.</p>
        ) : (
          <>
            <ul className="divide-y divide-ivory-200 text-sm md:hidden" data-testid="history-list">
              {history.map((h) => (
                <li key={h.id} className="py-2">
                  <p><strong>{h.userName}</strong> · {areaLabel(h.area)} → {actionLabel(h.action)} <Badge tone={h.toAllowed ? "green" : "red"}>{h.toAllowed ? "Granted" : "Removed"}</Badge></p>
                  <p className="text-xs text-slate-600">by {h.actorName} · {fmtDateTime(h.createdAt)} · {sourceLabel(h.source)}</p>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm" data-testid="history-table">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-600"><tr><th className="py-2">When</th><th>Changed by</th><th>Staff member</th><th>Area → action</th><th>Change</th><th>How</th></tr></thead>
                <tbody className="divide-y divide-ivory-200">
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td className="py-2 whitespace-nowrap text-slate-600">{fmtDateTime(h.createdAt)}</td>
                      <td>{h.actorName}</td>
                      <td className="font-semibold">{h.userName}</td>
                      <td>{areaLabel(h.area)} → {actionLabel(h.action)}</td>
                      <td>{h.fromAllowed ? "Allowed" : "Denied"} → <Badge tone={h.toAllowed ? "green" : "red"}>{h.toAllowed ? "Allowed" : "Denied"}</Badge></td>
                      <td className="text-slate-600">{sourceLabel(h.source)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </>
  );
}

