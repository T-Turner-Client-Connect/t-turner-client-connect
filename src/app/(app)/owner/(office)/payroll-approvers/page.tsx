import Link from "next/link";
import clsx from "clsx";
import { ActionForm } from "@/components/action-form";
import { Button, Card, EmptyState, PageHeader } from "@/components/ui";
import { setApproverAction } from "@/app/actions/payroll";
import { requireOffice } from "@/lib/auth/owner";
import { prisma } from "@/lib/prisma";
import { approverCandidates } from "@/lib/services/payroll-approval";
import { NOTIFY_CHANNELS } from "@/lib/payroll/fields";

export const metadata = { title: "Payroll approvers" };

/**
 * Owner's Office: which business owners approve each business's payroll, and which of them are
 * required. Owners never change this. Every change is audited.
 */
export default async function PayrollApproversPage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const { actor } = await requireOffice("payroll", "edit");
  const { client: selected } = await searchParams;
  const businesses = await prisma.client.findMany({
    where: { archivedAt: null, bookkeepingProfile: { payroll: true, active: true } },
    orderBy: { displayName: "asc" },
    select: { id: true, displayName: true, businessName: true, bookkeepingProfile: { select: { payrollProvider: true } }, payrollApprovers: { where: { active: true }, select: { required: true } } },
  });
  const current = businesses.find((b) => b.id === selected) ?? businesses[0];
  const candidates = current ? await approverCandidates(actor, current.id) : [];
  const name = (c: { displayName: string; businessName: string | null }) => c.businessName || c.displayName;
  return (
    <>
      <PageHeader title="Payroll approvers" subtitle="Choose which owners approve each business's payroll and which approvals are required. Fully approved payroll is never released automatically — the office submits it." />
      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <Card title="Payroll businesses">
          {!businesses.length ? <EmptyState title="No payroll clients">Turn on payroll for a bookkeeping client first.</EmptyState> : (
            <ul className="space-y-1 text-sm">
              {businesses.map((b) => {
                const req = b.payrollApprovers.filter((a) => a.required).length;
                return (
                  <li key={b.id}>
                    <Link href={`/owner/payroll-approvers?client=${b.id}`} className={clsx("block rounded-lg px-3 py-2", b.id === current?.id ? "bg-navy-900 text-white" : "hover:bg-navy-50")}>
                      <span className="font-semibold">{name(b)}</span>
                      <span className={clsx("block text-xs", b.id === current?.id ? "text-navy-100" : "text-slate-500")}>{b.bookkeepingProfile?.payrollProvider ?? "Provider not set"} · {b.payrollApprovers.length} approver{b.payrollApprovers.length === 1 ? "" : "s"}{b.payrollApprovers.length ? ` · ${req || b.payrollApprovers.length} required` : ""}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        {current && (
          <Card title={`${name(current)} — owners with portal access`} actions={<Link href={`/bookkeeping/${current.id}/payroll`} className="text-sm font-semibold text-navy-900 underline">Payroll page</Link>}>
            {!candidates.length ? <EmptyState title="No portal logins yet">Give the owners portal access to this business first; then choose approvers here.</EmptyState> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem] text-sm" data-testid="approver-designation">
                  <thead className="text-left text-xs uppercase tracking-wide text-navy-800"><tr><th className="py-2 pr-3">Owner</th><th className="py-2 pr-3">Payroll approval</th><th className="py-2 pr-3">Employee detail</th><th className="py-2 pr-3">Notified by</th><th className="py-2" /></tr></thead>
                  <tbody>
                    {candidates.map(({ portalUser, approver }) => {
                      const role = approver?.active ? (approver.required ? "REQUIRED" : "OPTIONAL") : "NONE";
                      return (
                        <tr key={portalUser.id} className="border-t border-navy-100 align-middle">
                          <td className="py-2 pr-3"><span className="font-semibold text-navy-900">{portalUser.name}</span><span className="block text-xs text-slate-500">{portalUser.email}</span></td>
                          <td className="py-2 pr-3" colSpan={2}>
                            <ActionForm action={setApproverAction.bind(null, current.id, portalUser.id)} className="flex flex-wrap items-center gap-3">
                              <select className="input py-1 text-sm" name="role" defaultValue={role} aria-label={`Payroll approval for ${portalUser.name}`}>
                                <option value="NONE">Not an approver</option>
                                <option value="OPTIONAL">Approver (optional)</option>
                                <option value="REQUIRED">Required approver</option>
                              </select>
                              <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" name="showEmployeeDetail" defaultChecked={approver?.showEmployeeDetail ?? true} /> Show per-employee figures</label>
                              <Button type="submit" variant="secondary" className="py-1 text-xs">Save</Button>
                            </ActionForm>
                          </td>
                          <td className="py-2 pr-3 text-xs text-slate-600">{approver?.active ? (approver.notifyChannel ? NOTIFY_CHANNELS[approver.notifyChannel as keyof typeof NOTIFY_CHANNELS] : "Default (email, plus text when allowed)") : "—"}</td>
                          <td />
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="mt-3 text-xs text-slate-600">If no one is marked required, every approver must approve. All required approvers must approve the same version; any office change starts a new version and approvals are requested again. Owners can only approve or deny — they can&apos;t change figures, employees, bank accounts or these settings.</p>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
