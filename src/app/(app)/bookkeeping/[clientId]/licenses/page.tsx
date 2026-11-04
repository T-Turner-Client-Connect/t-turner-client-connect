import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, PageHeader } from "@/components/ui";
import { addLicenseAction, removeLicenseAction, renewLicenseAction } from "@/app/actions/business-overview";
import { todayCentral } from "@/lib/services/square-billing";

export const metadata = { title: "Business Licenses" };

const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export default async function LicensesPage({ params }: { params: Promise<{ clientId: string }> }) {
  await connection();
  await requireUser();
  const { clientId } = await params;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { displayName: true, businessName: true } });
  if (!client) notFound();
  const today = todayCentral();
  const licenses = await prisma.businessLicense.findMany({ where: { clientId, archivedAt: null }, orderBy: [{ renewalDate: "asc" }, { name: "asc" }] });
  return (
    <>
      <PageHeader title="Business Licenses" subtitle={`${client.businessName || client.displayName} — licenses and permits, with renewal dates for the overview and deadlines.`} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Licenses" className="lg:col-span-2">
          {licenses.length ? (
            <ul className="divide-y divide-ivory-200" data-testid="license-list">
              {licenses.map((l) => {
                const r = l.renewalDate?.toISOString().slice(0, 10) ?? null;
                return (
                  <li key={l.id} className="flex flex-wrap items-end justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-navy-900">{l.name} {r && (r < today ? <Badge tone="red">Expired</Badge> : <Badge tone="green">Current</Badge>)}</p>
                      <p className="text-sm text-slate-600">{[l.jurisdiction, l.licenseNumber && `No. ${l.licenseNumber}`, l.renewalDate ? `Renews ${fmt(l.renewalDate)}` : "No renewal date"].filter(Boolean).join(" · ")}</p>
                      {l.note && <p className="text-sm text-slate-500">{l.note}</p>}
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <ActionForm action={renewLicenseAction.bind(null, l.id)} className="flex items-end gap-2">
                        <Field label="New renewal date"><input type="date" name="renewalDate" required className="input" defaultValue={r ?? ""} /></Field>
                        <Button type="submit" variant="secondary">Save</Button>
                      </ActionForm>
                      <ActionForm action={removeLicenseAction.bind(null, l.id)} confirm={`Remove ${l.name}? It stays in the history.`}><Button type="submit" variant="ghost">Remove</Button></ActionForm>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-slate-600">No licenses added yet.</p>
          )}
        </Card>
        <Card title="Add a license">
          <ActionForm action={addLicenseAction.bind(null, clientId)} className="space-y-3" resetOnSuccess>
            <Field label="License or permit"><input name="name" required maxLength={120} className="input" placeholder="e.g. Birmingham Business License" /></Field>
            <Field label="Issued by (optional)"><input name="jurisdiction" maxLength={120} className="input" placeholder="e.g. City of Birmingham" /></Field>
            <Field label="License number (optional)"><input name="licenseNumber" maxLength={60} className="input" /></Field>
            <Field label="Renewal date"><input type="date" name="renewalDate" className="input" /></Field>
            <Field label="Note (optional)"><input name="note" maxLength={300} className="input" /></Field>
            <Button type="submit">Add license</Button>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
