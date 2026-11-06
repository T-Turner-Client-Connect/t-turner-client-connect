import { notFound, redirect } from "next/navigation";
import { requirePayrollTaxPage } from "@/lib/payroll-taxes/access";

/** "Add schedule" on the Payroll tab: opens the editor for the chosen existing client. */
export default async function NewSchedule({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const { access } = await requirePayrollTaxPage();
  if (access.level !== "MANAGE") notFound();
  const id = (await searchParams).client ?? "";
  if (!/^[a-z0-9]{10,40}$/i.test(id)) redirect("/payroll-taxes?tab=payroll");
  redirect(`/payroll-taxes/schedules/${id}`);
}
