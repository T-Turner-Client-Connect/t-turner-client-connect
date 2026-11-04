import { notFound } from "next/navigation";
import { Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { repairJointNameAction } from "@/app/actions/client-repair";
import { proposedJointRepair } from "@/lib/services/client-repair";
import { looksCombined } from "@/lib/tax/return-types";
import { ClientForm } from "@/components/client-form";
import { updateClientAction } from "@/app/actions/clients";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { currentTaxYear, jointFilingNeeded } from "@/lib/services/clients";

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
  const spouseYear = currentTaxYear();
  const spouseNeeded = client.clientType === "INDIVIDUAL" && (await jointFilingNeeded(id, spouseYear));
  return (
    <>
      <PageHeader title={`Edit ${client.displayName}`} />
      {looksCombined(client) && (() => {
        const r = proposedJointRepair(client);
        return (
          <Card title="This record holds two people in one name" className="mb-4">
            <Notice tone="warn">“{[client.firstName, client.middleName, client.lastName].filter(Boolean).join(" ")}” looks like a joint return saved as one person. Check the split below and save — it stays ONE client record for the couple; nothing else on the record changes.</Notice>
            <ActionForm action={repairJointNameAction.bind(null, id)} className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field label="Taxpayer first name"><input className="input" name="firstName" defaultValue={r?.firstName ?? ""} required /></Field>
              <Field label="Middle / initial"><input className="input" name="middleName" defaultValue={r?.middleName ?? ""} /></Field>
              <Field label="Last name"><input className="input" name="lastName" defaultValue={r?.lastName ?? ""} required /></Field>
              <Field label="Spouse first name"><input className="input" name="spouseFirstName" defaultValue={r?.spouseFirstName ?? ""} required /></Field>
              <Field label="Spouse middle / initial"><input className="input" name="spouseMiddleName" defaultValue={r?.spouseMiddleName ?? ""} /></Field>
              <Field label="Spouse last name"><input className="input" name="spouseLastName" defaultValue={r?.spouseLastName ?? ""} required /></Field>
              <div className="sm:col-span-3"><Button type="submit">Confirm and save the split</Button></div>
            </ActionForm>
          </Card>
        );
      })()}
      <Card>
        <ClientForm
          action={updateClientAction.bind(null, id)}
          client={client}
          spouseYear={spouseYear}
          spouseNeeded={spouseNeeded}

          groups={groups}
          staff={staff}
          selectedGroupIds={client.groups.map((g) => g.groupId)}
          cancelHref={`/clients/${id}`}
        />
      </Card>
    </>
  );
}
