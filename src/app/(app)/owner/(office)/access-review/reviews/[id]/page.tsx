import Link from "next/link";
import { notFound } from "next/navigation";
import { WindowPrintButton } from "@/components/window-print-button";
import { requireOffice } from "@/lib/auth/owner";
import { getAccessReview } from "@/lib/services/access-review";
import { BUSINESS } from "@/lib/business";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Access review record" };

const cell = "border border-slate-300 px-2 py-1 align-top";

export default async function AccessReviewRecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor, access } = await requireOffice();
  if (!access.isOwner) notFound();
  const { id } = await params;
  const r = await getAccessReview(actor, id);
  if (!r) notFound();

  return (
    <article className="rounded-2xl bg-white p-5 text-sm text-slate-900 ring-1 ring-ivory-200 sm:p-8 print:rounded-none print:p-0 print:ring-0" data-testid="review-record">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link href="/owner/access-review" className="text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">← Access review</Link>
        <WindowPrintButton label="Print record" />
      </div>
      <header className="border-b-2 border-navy-900 pb-3">
        <p className="text-xs uppercase tracking-wide text-slate-600">{BUSINESS.legalName}</p>
        <h1 className="font-serif text-2xl font-bold text-navy-900">Access review record</h1>
        <p className="mt-1">Completed {fmtDateTime(r.completedAt)} by {r.reviewerName}. Record ID {r.id}.</p>
      </header>

      <section className="mt-4">
        <h2 className="font-serif text-lg font-bold text-navy-900">Summary</h2>
        <p className="whitespace-pre-wrap">{r.summary}</p>
        {r.findings && (
          <>
            <h3 className="mt-3 font-semibold text-navy-900">Findings and changes made</h3>
            <p className="whitespace-pre-wrap">{r.findings}</p>
          </>
        )}
      </section>

      <section className="mt-5">
        <h2 className="font-serif text-lg font-bold text-navy-900">Client Connect staff accounts ({r.staff.length})</h2>
        <div className="overflow-x-auto">
          <table className="mt-2 w-full border-collapse text-left text-xs">
            <thead className="bg-navy-50">
              <tr>
                {["Name", "Email", "Role", "Status", "Permission grants", "Two-step", "Last sign-in", "Created"].map((h) => <th key={h} className={cell}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {r.staff.map((s) => (
                <tr key={s.id}>
                  <td className={cell}>{s.name}{s.isOwner ? " (owner)" : ""}</td>
                  <td className={cell}>{s.email}</td>
                  <td className={cell}>{s.role === "ADMIN" ? "Admin" : "Staff"}</td>
                  <td className={cell}>{s.active ? "Active" : "Inactive"}</td>
                  <td className={cell}>{[...s.grants.map((g) => g.label), ...s.otherGrants].join("; ") || "None"}</td>
                  <td className={cell}>{s.twoStep ? "Yes" : "No"}</td>
                  <td className={cell}>{s.lastLoginAt ? fmtDateTime(new Date(s.lastLoginAt)) : "Never"}</td>
                  <td className={cell}>{fmtDate(new Date(s.createdAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-5 break-inside-avoid">
        <h2 className="font-serif text-lg font-bold text-navy-900">Vendor accounts</h2>
        <div className="overflow-x-auto">
          <table className="mt-2 w-full border-collapse text-left text-xs">
            <thead className="bg-navy-50">
              <tr>
                {["Account", "Access still appropriate", "Two-step verification on", "Note"].map((h) => <th key={h} className={cell}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {r.vendors.map((v) => (
                <tr key={v.key}>
                  <td className={cell}>{v.label}</td>
                  <td className={cell}>{v.appropriate ? "Yes" : "Not confirmed"}</td>
                  <td className={cell}>{v.twoStep ? "Yes" : "Not confirmed"}</td>
                  <td className={cell}>{v.note || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-5">
        <h2 className="font-serif text-lg font-bold text-navy-900">Access changes since the previous review ({r.changeList.length})</h2>
        {r.changeList.length === 0 ? (
          <p>None recorded.</p>
        ) : (
          <ul className="mt-1 list-disc pl-5">
            {r.changeList.map((c, i) => (
              <li key={i}>{fmtDateTime(new Date(c.at))} — {c.userName}: {c.text} (by {c.actorName})</li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-6 border-t border-slate-300 pt-2 text-xs text-slate-600">No credentials are stored in Client Connect. Vendor answers are the reviewer&apos;s own confirmation after signing in to each service.</p>
    </article>
  );
}
