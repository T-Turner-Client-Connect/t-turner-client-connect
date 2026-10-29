import { notFound } from "next/navigation";
import { Card, PageHeader } from "@/components/ui";
import { ClientForm } from "@/components/client-form";
import { updateClientAction } from "@/app/actions/clients";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Edit client" };

export default async function EditClientPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const [client, groups, staff] = await Promise.all([
    prisma.client.findUnique({ where: { id }, include: { groups: true } }),
    prisma.group.findMany({ orderBy: { name: "asc" } }),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  if (!client) notFound();
  return (
    <>
      <PageHeader title={`Edit ${client.displayName}`} />
      <Card>
        <ClientForm
          action={updateClientAction.bind(null, id)}
          client={client}
          groups={groups}
          staff={staff}
          selectedGroupIds={client.groups.map((g) => g.groupId)}
          cancelHref={`/clients/${id}`}
        />
      </Card>
    </>
  );
}
