import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, PageHeader } from "@/components/ui";
import { addSuggestedGroupsAction, createGroupAction, deleteGroupAction } from "@/app/actions/clients";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Groups" };

export default async function GroupsPage() {
  const user = await requireUser();
  const groups = await prisma.group.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { clients: { where: { client: { archivedAt: null } } } } } },
  });
  return (
    <>
      <PageHeader title="Groups" subtitle="Use groups to organize clients and pick campaign audiences." />
      <div className="grid gap-4 lg:grid-cols-3">
        <ul className="divide-y divide-navy-100 rounded-xl border border-navy-100 bg-white lg:col-span-2">
          {groups.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <Link href={`/clients?group=${g.id}`} className="font-semibold text-navy-900 underline">{g.name}</Link>
                {g.description && <p className="text-sm text-slate-600">{g.description}</p>}
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="gold">{g._count.clients} client{g._count.clients === 1 ? "" : "s"}</Badge>
                {user.role === "ADMIN" && (
                  <ActionForm action={deleteGroupAction.bind(null, g.id)} confirm={`Delete the group "${g.name}"? Clients stay in the CRM.`} showSuccess={false}>
                    <Button variant="ghost" className="text-red-700">Delete</Button>
                  </ActionForm>
                )}
              </div>
            </li>
          ))}
        </ul>
        <div className="space-y-4">
        <Card title="New group">
          <ActionForm action={createGroupAction} className="space-y-3" resetOnSuccess>
            <Field label="Name"><input className="input" name="name" required maxLength={100} /></Field>
            <Field label="Description"><input className="input" name="description" /></Field>
            <Button type="submit">Create group</Button>
          </ActionForm>
        </Card>
        {user.role === "ADMIN" && (
          <Card title="Suggested groups">
            <p className="mb-3 text-sm text-slate-600">Individual Tax Clients, Business Owners, Bookkeeping, Payroll, Nonprofit Interest and Prospects. Existing groups aren&apos;t changed.</p>
            <ActionForm action={addSuggestedGroupsAction}><Button type="submit" variant="secondary">Add suggested groups</Button></ActionForm>
          </Card>
        )}
        </div>
      </div>
    </>
  );
}
