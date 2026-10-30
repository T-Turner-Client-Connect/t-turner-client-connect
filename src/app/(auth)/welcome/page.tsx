import { CheckYourRefund } from "@/components/resources/check-refund";
import { refundLinks } from "@/lib/resources/refunds";
import Link from "next/link";
import { Briefcase, ShieldCheck } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/session";
import { getPortalUser } from "@/lib/portal/session";

export const metadata = { title: "Welcome" };

export default async function Welcome() {
  // Already signed in? Offer a way straight back in (each still checked on the server).
  const [staff, client] = await Promise.all([getCurrentUser(), getPortalUser()]);
  return (
    <>
      <h1 className="text-center text-2xl font-bold sm:text-3xl">Welcome to TTurner Client Connect</h1>
      <p className="mb-7 mt-2 text-center text-[15px] text-slate-600">Secure communication with TTurner &amp; Associates Group, LLC. Please choose how you&apos;re signing in.</p>
      <div className="space-y-4">
        <Link
          href={client ? "/client" : "/client/login"}
          className="flex min-h-16 items-center gap-4 rounded-xl bg-navy-900 px-5 py-4 text-white shadow-md hover:bg-navy-800"
        >
          <ShieldCheck className="size-8 shrink-0 text-gold-500" aria-hidden />
          <span className="flex-1">
            <span className="block font-serif text-xl font-semibold text-white">{client ? "Continue to my portal" : "Client Login"}</span>
            <span className="text-sm text-navy-100">Messages, documents, bookkeeping and tax updates</span>
          </span>
          <span aria-hidden className="text-2xl text-gold-500">→</span>
        </Link>
        <Link
          href={staff ? "/" : "/staff/login"}
          className="flex min-h-16 items-center gap-4 rounded-xl border-2 border-navy-900 bg-white px-5 py-4 text-navy-900 hover:bg-ivory-50"
        >
          <Briefcase className="size-8 shrink-0 text-navy-800" aria-hidden />
          <span className="flex-1">
            <span className="block font-serif text-xl font-semibold">{staff ? "Continue to the CRM" : "Staff Login"}</span>
            <span className="text-sm text-slate-600">For TTurner &amp; Associates Group team members</span>
          </span>
          <span aria-hidden className="text-2xl">→</span>
        </Link>
      </div>
      {!client && (
        <div className="mt-5 rounded-xl bg-ivory-50 p-4 text-center">
          <Link href="/client/signup" className="block w-full rounded-lg border-2 border-gold-500 bg-white px-4 py-3 font-serif text-lg font-semibold text-navy-900 hover:bg-gold-100">Create Client Account</Link>
          <p className="mt-2 text-sm"><Link href="/client/activate" className="underline">Already a client? Activate your portal.</Link></p>
        </div>
      )}
      <div className="mt-6"><CheckYourRefund {...(await refundLinks())} /></div>
      <p className="mt-6 text-center text-xs text-slate-500">Staff accounts are by invitation only.</p>
    </>
  );
}
