import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { ActionForm } from "@/components/action-form";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { payDateAction } from "@/app/actions/business-overview";
import { nextPayDate } from "@/lib/services/business-overview";
import { PAYROLL_FREQUENCIES } from "@/lib/services/bookkeeping-clients";
import { todayCentral } from "@/lib/services/square-billing";

export const metadata = { title: "Payroll" };

const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export default async function PayrollPage({ params }: { params: Promise<{ clientId: string }> }) {
  await connection();
  await requireUser();
  const { clientId } = await params;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { displayName: true, businessName: true, bookkeepingProfile: true } });
  if (!client) notFound();
  const p = client.bookkeepingProfile;
  const known = p?.payrollPayDate?.toISOString().slice(0, 10) ?? null;
  const next = nextPayDate(known, p?.payrollFrequency ?? null, todayCentral());
  const base = `/bookkeeping/${clientId}`;
  return (
    <>
      <PageHeader title="Payroll" subtitle={client.businessName || client.displayName} />
      {!p?.payroll ? (
        <Card><p className="text-sm text-slate-700">This client doesn&apos;t run payroll. Turn it on under <Link className="font-semibold underline" href={`${base}/close`}>Bookkeeping settings</Link>.</p></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Schedule">
            <dl className="space-y-1 text-sm" data-testid="payroll-schedule">
              <div className="flex justify-between gap-2"><dt>Provider</dt><dd className="font-semibold">{p.payrollProvider ?? "Not set"}</dd></div>
              <div className="flex justify-between gap-2"><dt>How often</dt><dd className="font-semibold">{p.payrollFrequency ? PAYROLL_FREQUENCIES[p.payrollFrequency as keyof typeof PAYROLL_FREQUENCIES] : "Not set"}</dd></div>
              <div className="flex justify-between gap-2"><dt>Next pay date</dt><dd className="font-semibold" data-testid="next-pay-date">{next ? fmt(next) : "Add a known pay date"}</dd></div>
            </dl>
            <p className="mt-2 text-xs text-slate-500">Provider and frequency are edited in Bookkeeping settings on the monthly close page. Twice-a-month payroll is shown as the 15th and the last day of the month.</p>
            <ActionForm action={payDateAction.bind(null, clientId)} className="mt-3 flex flex-wrap items-end gap-2">
              <Field label="A known pay date"><input type="date" name="payDate" className="input" defaultValue={known ?? ""} /></Field>
              <Button type="submit" variant="secondary">Save</Button>
            </ActionForm>
          </Card>
          <Card title="Payroll reports">
            <p className="text-sm text-slate-700">Each month&apos;s payroll reports are uploaded and checked off on the monthly close.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href={`${base}/close#payroll`} className="rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white">View payroll reports</Link>
              <Link href={`${base}/close#upload-financials`} className="rounded-lg border-[1.5px] border-navy-900 px-4 py-2 text-sm font-semibold text-navy-900">Upload a payroll report</Link>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
