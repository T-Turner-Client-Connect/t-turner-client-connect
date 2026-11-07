import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { SignAgreementPanel } from "@/components/agreements/sign-form";
import { AgreementText } from "@/components/agreements/bits";
import { portalDeclineAction, portalSignAction } from "@/app/actions/agreements";
import { portalViewer } from "@/lib/portal/viewer";
import { PreviewDisabled } from "@/components/portal/preview-off";
import { prisma } from "@/lib/prisma";
import { ForbiddenError } from "@/lib/auth/actor";
import { portalAgreement, SIGN_CONSENT } from "@/lib/services/agreements";
import type { Rendered } from "@/lib/agreements/catalog";
import { OFFICE_TZ } from "@/lib/dates";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Review & sign" };

/** One agreement in the portal: sign it (mobile-first), or view and download the signed copy. */
export default async function PortalAgreementPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ account?: string }> }) {
  const { id } = await params;
  const { account } = await searchParams;
  const v = await portalViewer("agreement", account);
  const { user } = v;
  const a = user
    ? await portalAgreement(user, id).catch((e) => {
        if (e instanceof ForbiddenError) notFound();
        throw e;
      })
    : ((await prisma.clientAgreement.findUnique({ where: { id } }).then((x) => (x ? { ...x, prefill: { name: "", address: "", phone: "", email: "" } } : null))) as unknown as Awaited<ReturnType<typeof portalAgreement>> | null) ?? notFound();
  // Only the accounts in view: in View as Client, never another client's agreement.
  if (!v.accounts.some((acc) => acc.clientId === a.clientId)) notFound();
  const f = a.frozenClauses as unknown as Pick<Rendered, "title" | "intro" | "questions"> & { clauses: Rendered["clauses"] };
  const back = `/client/agreements${account ? `?account=${encodeURIComponent(account)}` : ""}`;
  return (
    <div className="mx-auto max-w-2xl space-y-4" data-testid="portal-agreement">
      <Link href={back} className="inline-flex min-h-11 items-center text-base font-semibold text-navy-900 underline">← Pricing &amp; Agreements</Link>
      {a.status === "SENT" ? (
        <>
          <p className="text-base text-slate-800">Read the agreement, tick each numbered acknowledgment, confirm your details and type your signature.</p>
          <PreviewDisabled readOnly={v.readOnly}>
            <SignAgreementPanel r={f} textHash={a.textHash!} prefill={a.prefill} signAction={v.act(portalSignAction, a.id)} declineAction={v.act(portalDeclineAction, a.id)} consentText={SIGN_CONSENT} today={new Date().toLocaleDateString("en-US", { timeZone: OFFICE_TZ, dateStyle: "long" })} />
          </PreviewDisabled>
        </>
      ) : (
        <div className="space-y-4 rounded-2xl border border-navy-100 bg-white p-4 sm:p-6">
          <p className="text-base font-semibold text-navy-900">{a.status === "SIGNED" ? `Signed ${fmtDate(a.signedAt)} by ${a.signerName}` : a.status === "DECLINED" ? `Declined ${fmtDate(a.declinedAt)}` : "This agreement is no longer open for signature."}</p>
          {a.pdfDocumentId && <a className="inline-flex min-h-11 items-center gap-2 rounded-full bg-navy-900 px-5 text-base font-semibold text-white" href={v.linkFor(a.pdfDocumentId)} target="_blank" rel="noopener"><Download className="size-5" aria-hidden /> Download signed PDF</a>}
          <AgreementText r={f} />
        </div>
      )}
    </div>
  );
}
