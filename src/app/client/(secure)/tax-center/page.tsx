import Link from "next/link";
import { BellRing, ClipboardList, CloudUpload, FileSearch, FileWarning, IdCard, User, Users, UsersRound } from "lucide-react";
import { Notice } from "@/components/ui";
import { luxCard, NavyCard, PageBanner } from "@/components/portal/luxury";
import { QuestionnaireStart } from "@/components/portal/tax-pages";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { loadPortalHome } from "@/lib/portal/views";
import { identityChecklist } from "@/lib/services/identity";

export const metadata = { title: "My Tax Center" };

const cardCls = `${luxCard} flex flex-col`;
const btnNavy = "mt-4 inline-flex w-full items-center justify-center rounded-xl bg-gradient-to-b from-navy-900 to-navy-950 px-4 py-2.5 font-semibold text-white shadow hover:to-navy-900";

function CardHead({ icon: Icon, title, sub }: { icon: React.ComponentType<{ className?: string }>; title: string; sub: string }) {
  return (
    <>
      <span className="mb-3 flex size-14 items-center justify-center rounded-2xl border border-gold-300 bg-gold-50"><Icon className="size-8 text-gold-600" aria-hidden /></span>
      <h2 className="font-serif text-xl font-bold leading-snug text-navy-900">{title}</h2>
      <p className="mt-1 text-sm text-slate-600">{sub}</p>
    </>
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
    { label: "You", icon: User, ...group(["CLIENT"]) },
    { label: "Spouse", icon: UsersRound, ...group(["SPOUSE"]) },
    { label: "Dependents", icon: Users, ...group(["DEPENDENT"]) },
  ];

  return (
    <>
      <PageBanner icon={ClipboardList} title="My Tax Center" subtitle="Everything you need for your tax return, all in one place." />
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4" data-testid="tax-center">
        <section className={cardCls} data-testid="tile-questionnaire">
          <CardHead icon={ClipboardList} title="Complete Tax Questionnaire" sub="Tell us about your year so we can prepare your return." />
          <div className="mt-4"><QuestionnaireStart options={data.questionnaires} /></div>
        </section>
        <section className={cardCls} data-testid="tile-upload">
          <CardHead icon={CloudUpload} title="Upload Documents" sub="Send W-2s, 1099s, receipts and other tax documents securely." />
          <span className="flex-1" />
          <Link href={`/client/tax-center/upload${q}${yq}`} className={btnNavy} data-testid="upload-button">Upload Documents</Link>
        </section>
        <section className={cardCls} data-testid="tile-retrieve">
          <CardHead icon={FileSearch} title="Retrieve Tax Filings" sub="View, download or print returns our office has saved for you." />
          <span className="flex-1" />
          <Link href={`/client/taxes/filings${q}${yq}`} className={btnNavy} data-testid="retrieve-button">Retrieve Tax Filings</Link>
        </section>
        <section className={cardCls} data-testid="tile-notice">
          <CardHead icon={FileWarning} title="Upload Audit or Tax Notice" sub="Got a letter from the IRS or state? Send it so we can respond on time." />
          <span className="flex-1" />
          <Link href={`/client/tax-center/notice${q}${yq}`} className={btnNavy} data-testid="notice-button">Upload a Notice</Link>
        </section>
      </div>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1.4fr_1fr]">
        {current.canViewIdentity ? (
          <NavyCard icon={IdCard} title="Identity Documents">
            <ul className="divide-y divide-ivory-200" data-testid="identity-checklist">
              {idRows.map((r) => (
                <li key={r.label} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-navy-900"><r.icon className="size-5 text-gold-400" aria-hidden /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-serif text-lg font-bold text-navy-900">{r.label}</span>
                    <span className="block text-sm text-slate-600">
                      {r.people === 0 ? "None listed" : `Documents on file: ${r.onFile} of ${r.total}`}
                      {r.label === "Dependents" && r.people > 0 && ` · ${r.people} ${r.people === 1 ? "dependent" : "dependents"}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <Link href={`/client/identity${q}`} className="mt-3 inline-flex rounded-xl border-2 border-gold-500 bg-white px-5 py-2 font-semibold text-navy-900 hover:bg-gold-50">Manage Documents</Link>
          </NavyCard>
        ) : (
          <span className="hidden lg:block" />
        )}
        <NavyCard icon={BellRing} title="Quick Reminders">
          <ul className="space-y-2.5 text-[15px] text-navy-800" data-testid="quick-reminders">
            {[
              "Upload documents for the correct tax year.",
              "Identity documents stay on file — no need to send them every year.",
              "Send any IRS or state letter right away so we can meet its deadline.",
              "An extension gives you more time to file, not more time to pay.",
            ].map((t) => (
              <li key={t} className="flex gap-2"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-gold-500" aria-hidden />{t}</li>
            ))}
          </ul>
        </NavyCard>
      </div>
    </>
  );
}
