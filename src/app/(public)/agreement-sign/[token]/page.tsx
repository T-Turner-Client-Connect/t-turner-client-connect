import Link from "next/link";
import { connection } from "next/server";
import { SignAgreementPanel } from "@/components/agreements/sign-form";
import { linkDeclineAction, linkSignAction } from "@/app/actions/agreements";
import { LINK_MESSAGES, resolveSigningLink, SIGN_CONSENT, type LinkState } from "@/lib/services/agreements";
import type { Rendered } from "@/lib/agreements/catalog";
import { OFFICE_TZ } from "@/lib/dates";

export const metadata = { title: "Review and sign your agreement" };

/**
 * A secure, expiring, single-use signing link for a client with no portal login.
 * The link holds a random token; only its hash is stored. Signing or declining uses it up.
 */
export default async function AgreementSignLinkPage({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const { token } = await params;
  const v = await resolveSigningLink(token);
  if (v.state !== "OK" || !v.link) {
    const signed = v.link?.agreement.status === "SIGNED" && v.state === "USED";
    return (
      <div className="mx-auto max-w-md rounded-2xl border border-navy-100 bg-white p-6 text-center" data-testid="link-state">
        <h1 className="font-serif text-2xl font-bold text-navy-900">{signed ? "Agreement signed" : "This link can't be used"}</h1>
        <p className="mt-2 text-base text-slate-800">{signed ? "Thank you. T. Turner & Associates has your signed agreement." : LINK_MESSAGES[v.state as Exclude<LinkState, "OK">]}</p>
        <Link href="/client/login" className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-navy-900 px-4 text-base font-semibold text-white">Client login</Link>
      </div>
    );
  }
  const a = v.link.agreement;
  const f = a.frozenClauses as unknown as Pick<Rendered, "title" | "intro" | "questions"> & { clauses: Rendered["clauses"] };
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gold-700">Agreement for {a.client.displayName}</p>
        <p className="text-base text-slate-800">Read the agreement, tick each numbered acknowledgment, confirm your details and type your signature. This link works once and expires {v.link.expiresAt.toLocaleDateString("en-US", { timeZone: OFFICE_TZ, dateStyle: "long" })}.</p>
      </header>
      <SignAgreementPanel r={f} textHash={a.textHash!} prefill={v.prefill!} signAction={linkSignAction.bind(null, token)} declineAction={linkDeclineAction.bind(null, token)} consentText={SIGN_CONSENT} today={new Date().toLocaleDateString("en-US", { timeZone: OFFICE_TZ, dateStyle: "long" })} />
    </div>
  );
}
