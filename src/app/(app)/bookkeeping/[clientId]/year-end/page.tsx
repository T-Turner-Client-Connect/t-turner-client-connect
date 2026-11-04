import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, PageHeader } from "@/components/ui";
import { yearEndStageAction } from "@/app/actions/business-overview";
import { YEAR_END_STAGES } from "@/lib/services/business-overview";
import { todayCentral } from "@/lib/services/square-billing";

export const metadata = { title: "W-2 / 1099 Center" };

export default async function YearEndPage({ params }: { params: Promise<{ clientId: string }> }) {
  await connection();
  await requireUser();
  const { clientId } = await params;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { displayName: true, businessName: true } });
  if (!client) notFound();
  const rows = await prisma.yearEndFiling.findMany({ where: { clientId }, orderBy: { taxYear: "desc" } });
  const thisYear = Number(todayCentral().slice(0, 4));
  return (
    <>
      <PageHeader title="W-2 / 1099 Center" subtitle={`${client.businessName || client.displayName} — year-end W-2 and 1099 status by tax year. W-2s and 1099s are due January 31 of the next year.`} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="By tax year" className="lg:col-span-2">
          {rows.length ? (
            <ul className="divide-y divide-ivory-200" data-testid="year-end-list">
              {rows.map((r) => (
                <li key={r.id} className="py-3">
                  <p className="font-semibold text-navy-900">{r.taxYear} Year-End <Badge tone={r.stage === "FILED" ? "green" : r.stage === "NOT_STARTED" ? "gray" : "gold"}>{YEAR_END_STAGES[r.stage as keyof typeof YEAR_END_STAGES]?.label ?? r.stage}</Badge></p>
                  {r.note && <p className="text-sm text-slate-600">{r.note}</p>}
                  <p className="text-xs text-slate-500">Filing deadline: January 31, {r.taxYear + 1}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-600">Nothing recorded yet.</p>
          )}
        </Card>
        <Card title="Set the status">
          <ActionForm action={yearEndStageAction.bind(null, clientId)} className="space-y-3">
            <Field label="Tax year">
              <select name="taxYear" className="input" defaultValue={thisYear}>{[thisYear, thisYear - 1, thisYear - 2].map((y) => <option key={y} value={y}>{y}</option>)}</select>
            </Field>
            <Field label="Status">
              <select name="stage" className="input" defaultValue="CONTRACTOR_REVIEW">{Object.entries(YEAR_END_STAGES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
            </Field>
            <Field label="Note (optional)"><input name="note" maxLength={500} className="input" placeholder="e.g. Waiting on 2 W-9s" /></Field>
            <Button type="submit">Save</Button>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
