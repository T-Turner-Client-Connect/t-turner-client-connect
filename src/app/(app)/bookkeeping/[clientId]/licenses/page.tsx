import { redirect } from "next/navigation";

/** Licenses now live on Business Taxes & Licenses, with every other tax and filing the business owes. */
export default async function LicensesPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  redirect(`/bookkeeping/${clientId}/business-taxes#licenses`);
}
