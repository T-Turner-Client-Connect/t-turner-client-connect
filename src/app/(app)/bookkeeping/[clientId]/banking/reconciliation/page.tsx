import { redirect } from "next/navigation";

/** The Monthly Reconciliation page moved into Ask Coetha (Reconciliation section); old links still work. */
export default async function ReconciliationPage({ params, searchParams }: { params: Promise<{ clientId: string }>; searchParams: Promise<{ month?: string }> }) {
  const { clientId } = await params;
  const { month } = await searchParams;
  const q = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? `?month=${month}` : "";
  redirect(`/bookkeeping/${clientId}/coetha/ask${q}#reconciliation`);
}
