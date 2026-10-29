import Link from "next/link";
import { Notice, PageHeader } from "@/components/ui";
import { QuestionnairePicker } from "@/components/portal/questionnaire-picker";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { loadPortalHome } from "@/lib/portal/views";
import { fmtChicago } from "@/lib/tz";

export const metadata = { title: "My Tax Center" };

export default async function TaxCenter({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  if (!current.canViewTax) return <Notice>Tax information isn&apos;t included in your access to this account.</Notice>;
  const data = await loadPortalHome(current.clientId, current, user.id);
  const q = `?account=${current.clientId}`;
  return (
    <>
      <PageHeader title="My Tax Center" subtitle="Your questionnaire, documents and filings — one step at a time." />
      <div className="grid gap-4 lg:grid-cols-3" data-testid="tax-center">
        <section className="lux-tile rounded-2xl border border-ivory-200 bg-white p-5" data-testid="tile-questionnaire">
          <h2 className="font-serif text-xl font-bold">1. Complete Tax Questionnaire</h2>
          <p className="mb-3 text-sm text-slate-600">Tell us about your year so we can prepare your return.</p>
          <QuestionnairePicker options={data.questionnaires} />
        </section>
        <section className="lux-tile flex flex-col rounded-2xl border border-ivory-200 bg-white p-5" data-testid="tile-upload">
          <h2 className="font-serif text-xl font-bold">2. Upload Documents</h2>
          <p className="flex-1 text-sm text-slate-600">W-2s, 1099s, receipts and letters go into your secure Document Vault for the right tax year.</p>
          <Link href={`/client/documents${q}`} className="mt-4 inline-flex items-center justify-center rounded-xl bg-navy-900 px-4 py-2.5 font-semibold text-white hover:bg-navy-800" data-testid="upload-button">Upload documents →</Link>
        </section>
        <section className="lux-tile flex flex-col rounded-2xl border border-gold-500 bg-navy-900 p-5 text-white" data-testid="tile-retrieve">
          <h2 className="font-serif text-xl font-bold text-white">3. Retrieve Tax Filings</h2>
          <p className="flex-1 text-sm text-navy-100">Preview, download or print returns our office has saved to your account, 2020 onward.</p>
          <Link href={`/client/taxes/filings${q}`} className="mt-4 inline-flex items-center justify-center rounded-xl bg-gold-500 px-4 py-2.5 font-semibold text-navy-950 hover:bg-gold-300" data-testid="retrieve-button">Retrieve Tax Filings →</Link>
        </section>
      </div>

      <section className="mt-6 rounded-2xl border border-ivory-200 bg-white p-5" data-testid="service-progress">
        <h2 className="mb-3 font-serif text-xl font-bold">Progress</h2>
        {data.progress.map((y) => (
          <div key={y.year} className="mb-4 last:mb-0">
            <p className="mb-2 font-semibold text-navy-900">
              {y.year} tax year
              {y.estimatedCompletion && <span className="ml-2 font-normal text-slate-700">· Estimated completion {fmtChicago(y.estimatedCompletion, { month: "long", day: "numeric", year: "numeric" })}</span>}
            </p>
            <ol className="grid gap-2 sm:grid-cols-5">
              {y.steps.map((s) => (
                <li key={s.key} className={`rounded-xl p-3 ${s.done ? "bg-emerald-50 ring-1 ring-emerald-200" : "bg-ivory-100"}`} data-step={s.key}>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">{s.label}</p>
                  <p className={`text-sm font-semibold ${s.done ? "text-emerald-800" : "text-navy-900"}`}>{s.done ? "✓ " : ""}{s.value}</p>
                </li>
              ))}
            </ol>
            {y.estimateNote && <p className="mt-1 text-xs text-slate-600">{y.estimateNote}</p>}
          </div>
        ))}
        <p className="mt-2 text-xs text-slate-500">Each step is updated separately by our office. An estimate is not a guarantee.</p>
      </section>
    </>
  );
}
