import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { incompleteClients } from "@/lib/services/client-repair";

export const metadata = { title: "Imported client data check" };

export default async function ImportCheckPage() {
  await requireUser();
  const rows = await incompleteClients();
  return (
    <>
      <PageHeader title="Imported client data check" subtitle="Tax and imported clients still missing an address, spouse details, contact information, assigned staff or a return type." />
      {rows.length === 0 ? <EmptyState title="Every imported client is complete" /> : (
        <Card>
          <ul className="divide-y divide-ivory-200 text-sm" data-testid="incomplete-clients">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><Link className="font-semibold underline" href={`/clients/${r.id}/edit`}>{r.displayName}</Link> <span className="text-xs text-slate-500">· {r.assigned ?? "Unassigned"}</span></span>
                <span className="flex flex-wrap gap-1">{r.missing.map((m) => <Badge key={m} tone={m === "Name holds two people" ? "red" : "amber"}>{m}</Badge>)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
