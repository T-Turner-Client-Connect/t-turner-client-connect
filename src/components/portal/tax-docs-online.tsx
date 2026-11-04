import { ExternalLink, FileHeart, Landmark, ShieldCheck } from "lucide-react";

// Official government sign-in pages only. They open in a new tab; Client Connect never asks for or stores
// these passwords. Checked Nov 2026: healthcare.gov/tax-form-1095, irs.gov online account, ssa.gov/myaccount.
const LINKS = [
  {
    key: "1095a",
    icon: FileHeart,
    title: "1095-A (Marketplace health coverage)",
    where: "HealthCare.gov",
    how: "Sign in, open the application for the tax year you're filing, then Tax forms → Download PDF.",
    url: "https://www.healthcare.gov/tax-form-1095/",
  },
  {
    key: "irs",
    icon: Landmark,
    title: "W-2 / 1099 wage and income transcript",
    where: "IRS Online Account (sign in with ID.me)",
    how: "Sign in, then Tax Records → Transcripts. Free.",
    url: "https://www.irs.gov/payments/online-account-for-individuals",
  },
  {
    key: "ssa",
    icon: ShieldCheck,
    title: "SSA-1099 (Social Security benefits)",
    where: "my Social Security",
    how: "Sign in, then Replace Your Tax Form SSA-1099.",
    url: "https://www.ssa.gov/myaccount/",
  },
] as const;

/** "Get Your Tax Documents Online" — official sign-in links, on the portal home page and in Resources. */
export function TaxDocsOnline() {
  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-gold-200 bg-white shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)]" data-testid="tax-docs-online">
      <h2 className="bg-navy-900 px-5 py-3.5 font-serif text-xl font-bold text-white sm:text-2xl">Get Your Tax Documents Online</h2>
      <p className="px-5 pt-3 text-sm text-slate-600">Official sites open in a new tab. Download your form there, then upload it here under Upload Documents.</p>
      <ul className="grid grid-cols-1 gap-3 p-4 md:grid-cols-3">
        {LINKS.map((l) => (
          <li key={l.key}>
            <a href={l.url} target="_blank" rel="noopener noreferrer" className="flex h-full flex-col gap-1 rounded-xl border border-gold-300 bg-gold-50/60 p-4 hover:border-gold-500 hover:bg-gold-50" data-testid={`link-${l.key}`}>
              <span className="flex items-center gap-2 font-semibold text-navy-900"><l.icon className="size-5 shrink-0 text-gold-600" aria-hidden />{l.title}</span>
              <span className="flex items-center gap-1 text-sm font-semibold text-gold-800">{l.where} <ExternalLink className="size-3.5" aria-hidden /></span>
              <span className="text-xs text-slate-600">{l.how}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
