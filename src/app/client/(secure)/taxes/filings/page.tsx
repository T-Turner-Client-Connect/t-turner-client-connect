import Link from "next/link";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { emailMyCopyAction } from "@/app/actions/tax-returns";
import { filingLabel, lastCopyEmails } from "@/lib/services/tax-returns";
import { PrintButton } from "@/components/print-button";
import { VerifyEmailCard } from "@/components/verification";
import { requestCopyAction } from "@/app/actions/tax-center";
import { confirmVerifyEmailAction, sendVerifyEmailAction } from "@/app/actions/verification";
import { portalViewer } from "@/lib/portal/viewer";
import { NoPortalLoginNotice, PreviewDisabled } from "@/components/portal/preview-off";
import { isPortalVerified, retrieveFilings, retrieveYears } from "@/lib/services/tax-center";
import { emailProviderConfigured } from "@/lib/auth/client-auth";
import { maskEmail } from "@/lib/services/mfa";
import { ALL_DOC_TYPES } from "@/lib/document-types";
import { formatBytes } from "@/lib/files";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Retrieve Tax Filings" };

const GROUPS = [
  ["FEDERAL", "Federal returns"],
  ["STATE", "State returns"],
  ["AMENDED", "Amended returns"],
  ["RELATED", "Related records (acknowledgments, extensions, notices)"],
] as const;

export default async function RetrieveFilings({ searchParams }: { searchParams: Promise<{ account?: string; year?: string }> }) {
  await connection();
  const sp = await searchParams;
  const v = await portalViewer("filings", sp.account);
  const { user, current } = v;
  if (!current) return null;
  const q = `?account=${current.clientId}`;
  const header = <PageHeader title="Retrieve Tax Filings" subtitle={<>Returns and records for <strong>{current.client.businessName || current.client.displayName}</strong>, released by our office. This doesn&apos;t pull anything from TaxAct or the IRS.</>} />;
  if (!current.canViewTax) return <>{header}<Notice>Tax records aren&apos;t included in your access to this account.</Notice></>;

  if (!user) return <>{header}<NoPortalLoginNotice /></>;
  if (!(await isPortalVerified(user.id))) {
    return (
      <>
        {header}
        <Card title="Verify your account to open past tax records" className="max-w-2xl">
          <p className="mb-3 text-sm text-slate-700">For your protection, past-year returns open only after we&apos;ve confirmed this login belongs to you.</p>
          {emailProviderConfigured() ? (
            <PreviewDisabled readOnly={v.readOnly}><VerifyEmailCard verified={false} masked={maskEmail(user.email)} emailReady sendAction={v.act(sendVerifyEmailAction, "portal")} confirmAction={v.act(confirmVerifyEmailAction, "portal")} /></PreviewDisabled>
          ) : (
            <p className="text-sm text-slate-700" data-testid="verify-by-office">Please call or message our office — we&apos;ll confirm your identity and unlock your records.</p>
          )}
          <Link href={`/client/messages${q}`} className="mt-3 inline-block text-sm font-semibold underline">Message our office</Link>
        </Card>
      </>
    );
  }

  const years = retrieveYears();
  const year = years.includes(Number(sp.year)) ? Number(sp.year) : years[1] ?? years[0];
  const r = await retrieveFilings(user, current.clientId, year);
  const emails = await lastCopyEmails(user.id);
  const link = v.linkFor;

  return (
    <>
      {header}
      <nav aria-label="Tax year" className="mb-5 flex flex-wrap gap-2" data-testid="year-picker">
        {years.map((y) => (
          <Link key={y} href={`/client/taxes/filings${q}&year=${y}`} aria-current={y === year ? "page" : undefined} className={`rounded-full px-4 py-1.5 text-sm font-semibold ${y === year ? "bg-navy-900 text-gold-300 ring-2 ring-gold-500" : "bg-white text-navy-900 ring-1 ring-ivory-200 hover:bg-gold-100"}`}>
            {y}
          </Link>
        ))}
      </nav>

      <h2 className="mb-3 font-serif text-xl font-bold">{year} tax year</h2>
      {r.total === 0 ? (
        <Card title={`No ${year} records in your account yet`}>
          <p className="mb-3 text-sm text-slate-700">If we prepared your {year} return, we can add a copy here.</p>
          {r.openRequest ? (
            <Notice tone="success">You asked for a copy on {fmtDate(r.openRequest.createdAt)}. Our office is working on it and will reply in Messages.</Notice>
          ) : (
            <PreviewDisabled readOnly={v.readOnly}>
              <ActionForm action={v.act(requestCopyAction, current.clientId, year)} className="max-w-lg space-y-2">
                <Field label="Anything we should know? (optional)"><input className="input" name="note" placeholder="e.g. I need the state return too" /></Field>
                <Button type="submit" variant="gold">Request a Copy</Button>
              </ActionForm>
            </PreviewDisabled>
          )}
        </Card>
      ) : (
        <div className="space-y-4" data-testid="filing-groups">
          {GROUPS.filter(([k]) => r.groups[k].length).map(([k, label]) => (
            <Card key={k} title={label}>
              <ul className="divide-y divide-navy-100" data-group={k}>
                {r.groups[k].map((d) => {
                  const href = link(d.id);
                  return (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <span>
                        <strong className="text-navy-900">{d.title}</strong>
                        {(() => {
                          // "Accepted Return" only from the filing record's verified acknowledgment — never from the PDF itself.
                          const fl = filingLabel(d.filing?.filingStatus);
                          return fl ? <span className="ml-2" data-testid="filing-label"><Badge tone={fl.tone}>{fl.label}</Badge></span> : null;
                        })()}
                        <span className="block text-xs text-slate-600">
                          {d.docType ? ALL_DOC_TYPES[d.docType] ?? "Document" : "Document"}
                          {d.filing && ` · ${d.filing.jurisdiction === "FEDERAL" ? "Federal" : d.filing.jurisdiction} ${d.filing.returnType}`} · added {fmtDate(d.publishedAt)} · {formatBytes(d.file.sizeBytes)}
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-2">
                        <a href={href} target="_blank" rel="noopener" className="rounded-lg bg-navy-900 px-3 py-1.5 text-sm font-semibold text-white">View</a>
                        <a href={`${href}?download=1`} className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-semibold text-navy-900">Download</a>
                        <PrintButton href={href} />
                        <PreviewDisabled readOnly={v.readOnly} className="inline-block">
                          <ActionForm action={v.act(emailMyCopyAction, current.clientId, d.id)} className="inline">
                            <Button type="submit" variant="ghost">Email My Copy</Button>
                          </ActionForm>
                        </PreviewDisabled>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
          {emails.length > 0 && (
            <p className="text-xs text-slate-600" data-testid="copy-email-status">
              Email My Copy: {emails.map((e) => `${e.status === "SENT" ? "sent" : "not sent"} ${fmtDate(e.createdAt)}${e.statusDetail ? ` — ${e.statusDetail}` : ""}`).join(" · ")}
            </p>
          )}
          <p className="text-xs text-slate-600">Email My Copy sends a secure sign-in link to your verified email — never the file itself.</p>
          <p className="text-xs text-slate-600">Missing something for {year}? <Link className="underline" href={`/client/messages${q}`}>Message our office</Link>.</p>
        </div>
      )}
    </>
  );
}
