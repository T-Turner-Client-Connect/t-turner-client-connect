import { PageHeader } from "@/components/ui";
import { ImportWizard } from "@/components/import-wizard";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Import contacts" };

export default async function NewImportPage() {
  await requireUser();
  const [staff, groups] = await Promise.all([
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.group.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return (
    <>
      <PageHeader
        title="Import contacts"
        subtitle="From a TaxAct client export or any CSV/XLSX contact list. Importing never sends messages and never marks anyone as opted in."
      />
      <ImportWizard staff={staff} groups={groups} />
    </>
  );
}
