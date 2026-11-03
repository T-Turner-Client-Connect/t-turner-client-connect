import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { mergePreview } from "@/lib/services/client-merge";
import { mergeClientsAction } from "@/app/actions/client-repair";

export const metadata = { title: "Compare clients" };

export default async function MergePage({ searchParams }: { searchParams: Promise<{ keep?: string; dup?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  let p: Awaited<ReturnType<typeof mergePreview>> | null = null;
  let error: string | null = null;
  try {
    p = await mergePreview(sp.keep ?? "", sp.dup ?? "");
  } catch (e) {
    error = e instanceof Error ? e.message : "Couldn't compare these records.";
  }
  if (!p) return <><PageHeader title="Compare clients" /><Notice tone="error">{error}</Notice></>;
  return (
    <>
      <PageHeader title="Compare and merge" subtitle={<span>Keep <strong>{p.keep.displayName}</strong> · merge in <strong>{p.dup.displayName}</strong> · <Link className="underline" href={`/clients/duplicates/merge?keep=${p.dup.id}&dup=${p.keep.id}`}>swap which one to keep</Link></span>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="What moves to the kept record">
          {p.moves.length === 0 ? <p className="text-sm text-slate-600">The duplicate has no tax cases, documents or history attached.</p> : (
            <ul className="text-sm" data-testid="merge-moves">{p.moves.map((m) => <li key={m.label}>{m.label}: <strong>{m.count}</strong></li>)}</ul>
          )}
          <p className="mt-2 text-xs text-slate-600">Groups, services and tags are combined. The duplicate is then <strong>archived, not deleted</strong>, marked “merged into {p.keep.displayName}”, and keeps its own audit history.</p>
        </Card>
        <Card title="Must be resolved first">
          {p.conflicts.length === 0 ? <Notice tone="success">No conflicts.</Notice> : <ul className="list-disc pl-5 text-sm text-red-800" data-testid="merge-conflicts">{p.conflicts.map((c) => <li key={c}>{c}</li>)}</ul>}
        </Card>
      </div>
      <Card title="Details" className="mt-4">
        <ActionForm action={mergeClientsAction.bind(null, p.keep.id, p.dup.id)} className="space-y-3" confirm={`Merge ${p.dup.displayName} into ${p.keep.displayName}? The duplicate will be archived.`}>
          {p.fields.length === 0 ? <p className="text-sm text-slate-600">The duplicate has no details the kept record is missing.</p> : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-slate-600"><th className="py-1">Field</th><th className="py-1">Kept record</th><th className="py-1">Duplicate</th><th className="py-1">Result</th></tr></thead>
              <tbody className="divide-y divide-ivory-200">
                {p.fields.map((f) => (
                  <tr key={f.field}>
                    <td className="py-1 font-medium">{f.label}</td>
                    <td className="py-1">{f.keep ?? "—"}</td>
                    <td className="py-1">{f.duplicate}</td>
                    <td className="py-1">{f.outcome === "fill" ? <Badge tone="navy">Fills blank</Badge> : <label className="flex items-center gap-1"><input type="checkbox" name="useDuplicate" value={f.field} className="accent-navy-900" /> Use duplicate&apos;s</label>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {user.role === "ADMIN" ? (
            <>
              <Field label={`Type “${p.dup.displayName}” to confirm`}><input className="input" name="confirmName" autoComplete="off" required /></Field>
              <Button type="submit" disabled={p.conflicts.length > 0}>Merge into {p.keep.displayName}</Button>
            </>
          ) : <Notice tone="info">Only an Admin can merge client records.</Notice>}
        </ActionForm>
      </Card>
    </>
  );
}
