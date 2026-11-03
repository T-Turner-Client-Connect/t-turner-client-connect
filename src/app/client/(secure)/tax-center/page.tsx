import Link from "next/link";
import { CalendarDays, Check, CircleCheck, ClipboardCheck, CloudUpload, FileCheck2, FolderOpen, IdCard, Mail, Pencil, User, Users, UsersRound } from "lucide-react";
import { Notice } from "@/components/ui";
import { QuestionnaireStart } from "@/components/portal/tax-pages";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { loadPortalHome } from "@/lib/portal/views";
import { identityChecklist } from "@/lib/services/identity";

export const metadata = { title: "My Tax Center" };

type Icon = React.ComponentType<{ className?: string; strokeWidth?: number }>;
const cream = "border border-gold-300 bg-gradient-to-b from-white to-ivory-50 text-navy-900";
const navy = "bg-gradient-to-br from-navy-900 to-navy-950 text-white ring-1 ring-navy-800";
const btnGold = "inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-b from-gold-300 to-gold-500 px-7 py-2.5 font-bold text-navy-950 shadow hover:to-gold-400";
const btnOutline = "inline-flex items-center justify-center gap-2 rounded-full border-2 border-gold-400 px-7 py-2.5 font-bold text-white hover:bg-white/10";

/** One of the four action cards: icon beside the title, centered text, button at the bottom. */
function ActionCard({ tone, icon: I, title, sub, children, testId }: { tone: "cream" | "navy"; icon: Icon; title: string; sub: string; children: React.ReactNode; testId: string }) {
  const dark = tone === "navy";
  return (
    <section className={`flex min-w-0 flex-col rounded-2xl p-5 shadow-[0_14px_32px_-22px_rgb(10_26_68/0.55)] ${dark ? navy : cream}`} data-testid={testId}>
      <div className="flex items-center gap-3">
        <I className={`size-12 shrink-0 ${dark ? "text-gold-400" : "text-gold-600"}`} strokeWidth={1.5} aria-hidden />
        <h2 className={`font-serif text-2xl font-bold leading-tight ${dark ? "text-white" : "text-navy-900"}`}>{title}</h2>
      </div>
      <p className={`mt-3 text-center text-[15px] ${dark ? "text-navy-100" : "text-navy-800"}`}>{sub}</p>
      <div className="mt-auto pt-4 text-center">{children}</div>
    </section>
  );
}

export default async function TaxCenter({ searchParams }: { searchParams: Promise<{ account?: string; year?: string }> }) {
  const user = await requirePortalUser();
  const sp = await searchParams;
  const { current } = await resolveAccount(user.id, sp.account);
  if (!current) return null;
  if (!current.canViewTax) return <Notice>Tax information isn&apos;t included in your access to this account.</Notice>;
  const data = await loadPortalHome(current.clientId, current, user.id);
  const q = `?account=${current.clientId}`;
  const yq = sp.year ? `&year=${sp.year}` : "";
  const idList = current.canViewIdentity ? await identityChecklist(current.clientId) : [];
  const group = (roles: string[]) => {
    const people = idList.filter((p) => roles.includes(p.person.role));
    const items = people.flatMap((p) => p.items);
    return { people: people.length, onFile: items.filter((i) => i.state === "ON_FILE").length, total: items.length };
  };
  const idRows = [
    { label: "You (Taxpayer)", icon: User, ...group(["CLIENT"]) },
    { label: "Spouse", icon: UsersRound, ...group(["SPOUSE"]) },
    { label: "Dependents (Children)", icon: Users, ...group(["DEPENDENT"]) },
  ];

  return (
    <>
      {/* Light banner: tax-document icon, thin divider, serif title, navy-and-gold swoosh. */}
      <section className="relative -mx-4 -mt-6 mb-6 overflow-hidden border-b border-ivory-200 bg-gradient-to-r from-ivory-50 via-white to-white px-4 py-6 sm:-mx-6 sm:px-8" data-testid="page-banner">
        <svg className="pointer-events-none absolute inset-y-0 right-0 hidden h-full w-[48%] md:block" viewBox="0 0 600 130" preserveAspectRatio="none" aria-hidden>
          <path d="M0 130 C 220 120, 380 70, 600 22 L 600 130 Z" fill="#0A1A44" />
          <path d="M60 130 C 260 112, 420 58, 600 6" fill="none" stroke="#C89D29" strokeWidth="10" />
          <path d="M0 126 C 240 116, 400 74, 600 30" fill="none" stroke="#E6C76A" strokeWidth="3" opacity="0.8" />
        </svg>
        <div className="relative flex items-center gap-4 sm:gap-5 md:max-w-[62%]">
          <FileCheck2 className="size-12 shrink-0 text-gold-500 sm:size-16" strokeWidth={1.5} aria-hidden />
          <span className="h-14 w-px shrink-0 bg-gold-400 sm:h-16" aria-hidden />
          <div className="min-w-0">
            <h1 className="font-serif text-3xl font-bold leading-tight text-navy-900 sm:text-[2.6rem]">My Tax Center</h1>
            <p className="mt-1 text-[15px] text-navy-800 sm:text-lg">Your tax information, documents, and filings — all in one place.</p>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4" data-testid="tax-center">
        <ActionCard tone="cream" icon={ClipboardCheck} title="Complete Tax Questionnaire" sub="Tell us about your year so we can prepare your return." testId="tile-questionnaire">
          <div className="text-left"><QuestionnaireStart options={data.questionnaires} /></div>
        </ActionCard>
        <ActionCard tone="navy" icon={CloudUpload} title="Upload Documents" sub="W-2s, 1099s, receipts and letters go into your secure Document Vault." testId="tile-upload">
          <Link href={`/client/tax-center/upload${q}${yq}`} className={btnOutline} data-testid="upload-button">Upload Documents <span aria-hidden>→</span></Link>
        </ActionCard>
        <ActionCard tone="cream" icon={FolderOpen} title="Retrieve Tax Filings" sub="View, download or print current and prior year returns." testId="tile-retrieve">
          <Link href={`/client/taxes/filings${q}${yq}`} className={btnGold} data-testid="retrieve-button">Retrieve Filings <span aria-hidden>→</span></Link>
        </ActionCard>
        <ActionCard tone="navy" icon={Mail} title="Upload Audit or Tax Notice" sub="Received a letter from the IRS or state? Upload it here so we can review and respond." testId="tile-notice">
          <Link href={`/client/tax-center/notice${q}${yq}`} className={btnOutline} data-testid="notice-button">Upload a Notice <span aria-hidden>→</span></Link>
        </ActionCard>
      </div>

      <div className="mt-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-[1.7fr_1fr]">
        {current.canViewIdentity ? (
          <section className={`min-w-0 rounded-2xl p-5 shadow-[0_14px_32px_-22px_rgb(10_26_68/0.45)] ${cream}`} data-testid="identity-summary">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <IdCard className="size-11 shrink-0 text-gold-600" strokeWidth={1.5} aria-hidden />
                <div>
                  <h2 className="font-serif text-2xl font-bold leading-tight text-navy-900">Identity Documents</h2>
                  <p className="text-sm text-navy-800">Upload once and keep on file. Driver&apos;s licenses are only updated when they expire.</p>
                </div>
              </div>
              <Link href={`/client/identity${q}`} className="inline-flex items-center gap-2 rounded-full border border-gold-500 bg-gradient-to-b from-gold-50 to-gold-200 px-5 py-2 text-sm font-bold text-navy-950 shadow-sm hover:to-gold-300">
                <Pencil className="size-4" aria-hidden /> Manage Documents
              </Link>
            </div>
            <ul className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3 sm:divide-x sm:divide-gold-200" data-testid="identity-checklist">
              {idRows.map((r) => (
                <li key={r.label} className="sm:px-4 sm:first:pl-0">
                  <span className="flex items-center gap-2 font-serif text-lg font-bold text-navy-900"><r.icon className="size-6 shrink-0 text-gold-600" aria-hidden />{r.label}</span>
                  {r.onFile > 0 ? (
                    <span className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-emerald-700"><CircleCheck className="size-5 fill-emerald-600 text-white" aria-hidden />Documents on file</span>
                  ) : (
                    <span className="mt-1 block text-sm text-slate-500">Not on file yet</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <span className="hidden lg:block" />
        )}
        <section className={`min-w-0 rounded-2xl p-5 shadow-[0_14px_32px_-22px_rgb(10_26_68/0.45)] ${cream}`} data-testid="quick-reminders">
          <h2 className="mb-3 flex items-center gap-3 font-serif text-2xl font-bold text-navy-900"><CalendarDays className="size-8 text-gold-600" strokeWidth={1.5} aria-hidden />Quick Reminders</h2>
          <ul className="space-y-2.5 text-[15px] text-navy-800">
            {[
              "Keep your information up to date.",
              "Upload new tax documents as you receive them.",
              "Update your driver's license only when it expires.",
              "Documents are securely stored year to year.",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-gold-500"><Check className="size-3.5 text-white" strokeWidth={3} aria-hidden /></span>
                {t}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
