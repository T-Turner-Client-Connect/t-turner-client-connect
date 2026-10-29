import { PageHeader } from "@/components/ui";
import { ImportWizard } from "@/components/import-wizard";
import { requireUser } from "@/lib/auth/session";

export const metadata = { title: "Import contacts" };

export default async function NewImportPage() {
  await requireUser();
  return (
    <>
      <PageHeader
        title="Import contacts"
        subtitle="From a TaxAct client export or any CSV/XLSX contact list. Importing never sends messages and never marks anyone as opted in."
      />
      <ImportWizard />
    </>
  );
}
