import { Card, PageHeader } from "@/components/ui";
import { ClientForm } from "@/components/client-form";
import { createClientAction } from "@/app/actions/clients";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Add client" };

export default async function NewClientPage() {
  await requireUser();
  const [groups, staff] = await Promise.all([
    prisma.group.findMany({ orderBy: { name: "asc" } }),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return (
    <>
      <PageHeader title="Add client" subtitle="New clients start with no messaging permissions until you record them." />
      <Card><ClientForm action={createClientAction} groups={groups} staff={staff} cancelHref="/clients" /></Card>
    </>
  );
}
