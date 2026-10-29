"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Notice } from "@/components/ui";
import { setAudienceAction } from "@/app/actions/campaigns";

export type PickerClient = {
  id: string;
  name: string;
  business: string | null;
  type: string;
  status: string;
  groupIds: string[];
  tags: string[];
  hasEmail: boolean;
  hasPhone: boolean;
};

export function AudiencePicker({
  campaignId,
  groups,
  clients,
  initialGroupIds,
  initialClientIds,
  excludedIds,
  editable,
}: {
  campaignId: string;
  groups: { id: string; name: string; count: number }[];
  clients: PickerClient[];
  initialGroupIds: string[];
  initialClientIds: string[];
  excludedIds: string[];
  editable: boolean;
}) {
  const router = useRouter();
  const [groupIds, setGroupIds] = useState(new Set(initialGroupIds));
  const [clientIds, setClientIds] = useState(new Set(initialClientIds));
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [group, setGroup] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const [message, setMessage] = useState<{ ok?: string; error?: string } | null>(null);
  const [pending, start] = useTransition();
  const excluded = useMemo(() => new Set(excludedIds), [excludedIds]);

  const viaGroup = (c: PickerClient) => c.groupIds.some((g) => groupIds.has(g));
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return clients.filter(
      (c) =>
        (!needle || c.name.toLowerCase().includes(needle) || c.business?.toLowerCase().includes(needle) || c.tags.some((t) => t.toLowerCase().includes(needle))) &&
        (!type || c.type === type) &&
        (!status || c.status === status) &&
        (!group || c.groupIds.includes(group)) &&
        (!onlySelected || clientIds.has(c.id) || c.groupIds.some((g) => groupIds.has(g))),
    );
  }, [clients, q, type, status, group, onlySelected, clientIds, groupIds]);

  const totalSelected = clients.filter((c) => clientIds.has(c.id) || viaGroup(c)).length;
  const dirty =
    groupIds.size !== initialGroupIds.length || clientIds.size !== initialClientIds.length ||
    initialGroupIds.some((g) => !groupIds.has(g)) || initialClientIds.some((c) => !clientIds.has(c));

  const toggle = <T,>(set: Set<T>, value: T, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(value);
    else next.delete(value);
    return next;
  };

  function save() {
    start(async () => {
      const res = await setAudienceAction(campaignId, [...groupIds], [...clientIds]);
      setMessage(res);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-navy-100 bg-white p-4">
        <h3 className="mb-2 font-semibold">Groups</h3>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => (
            <label key={g.id} className="flex items-center justify-between gap-2 rounded-lg border border-navy-100 px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                <input type="checkbox" className="size-4 accent-navy-900" disabled={!editable} checked={groupIds.has(g.id)} onChange={(e) => setGroupIds(toggle(groupIds, g.id, e.target.checked))} />
                {g.name}
              </span>
              <Badge tone="gray">{g.count}</Badge>
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-navy-100 bg-white p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Individual clients</h3>
          <p className="text-sm text-slate-600"><strong>{totalSelected}</strong> selected in total (groups + individuals)</p>
        </div>
        <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <input className="input lg:col-span-2" placeholder="Search name, business or tag" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search clients" />
          <select className="input" value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
            <option value="">Any type</option><option value="INDIVIDUAL">Individual</option><option value="BUSINESS">Business</option><option value="NONPROFIT">Nonprofit</option>
          </select>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">Any status</option><option value="ACTIVE">Active</option><option value="PROSPECT">Prospect</option><option value="INACTIVE">Inactive</option>
          </select>
          <select className="input" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group filter">
            <option value="">Any group</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button variant="secondary" disabled={!editable} onClick={() => setClientIds(new Set([...clientIds, ...filtered.map((c) => c.id)]))}>
            Select all{filtered.length !== clients.length ? ` ${filtered.length} shown` : ""}
          </Button>
          <Button variant="secondary" disabled={!editable} onClick={() => { setClientIds(new Set()); setGroupIds(new Set()); }}>Clear all</Button>
          <label className="ml-1 flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-navy-900" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} /> Show selected only
          </label>
        </div>
        <ul className="max-h-[28rem] divide-y divide-navy-100 overflow-y-auto rounded-lg border border-navy-100">
          {filtered.slice(0, 500).map((c) => {
            const inGroup = viaGroup(c);
            return (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-navy-50">
                  <input
                    type="checkbox"
                    className="size-4 accent-navy-900"
                    disabled={!editable}
                    checked={clientIds.has(c.id) || inGroup}
                    onChange={(e) => setClientIds(toggle(clientIds, c.id, e.target.checked))}
                    aria-describedby={inGroup ? `via-${c.id}` : undefined}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.name}{c.business && c.business !== c.name ? ` · ${c.business}` : ""}</span>
                    <span className="text-xs text-slate-600">{[c.hasEmail && "Email", c.hasPhone && "Mobile"].filter(Boolean).join(" + ") || "No email or mobile"}</span>
                  </span>
                  {inGroup && <Badge tone="gold"><span id={`via-${c.id}`}>Via group</span></Badge>}
                  {excluded.has(c.id) && <Badge tone="red">Removed</Badge>}
                </label>
              </li>
            );
          })}
          {filtered.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-600">No clients match.</li>}
          {filtered.length > 500 && <li className="px-3 py-2 text-center text-xs text-slate-600">Showing the first 500 — narrow the search to see more. &quot;Select all&quot; still includes every match.</li>}
        </ul>
        <p className="mt-2 text-xs text-slate-600">
          Clients picked through a group stay selected while the group is checked. To leave someone out of this campaign only, remove them on the Review step — their groups and record aren&apos;t changed, and the removal is kept even if you change this selection.
        </p>
      </section>

      {editable && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={save} disabled={pending || !dirty}>{pending ? "Saving…" : "Save audience"}</Button>
          {dirty && <span className="text-sm text-amber-800">Unsaved changes</span>}
        </div>
      )}
      {message?.error && <Notice tone="error">{message.error}</Notice>}
      {message?.ok && !dirty && <Notice tone="success">{message.ok} Check the Review step to see who will receive it.</Notice>}
    </div>
  );
}
