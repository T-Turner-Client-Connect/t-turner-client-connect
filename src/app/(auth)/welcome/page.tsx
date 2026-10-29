import Link from "next/link";
import { Briefcase, ShieldCheck } from "lucide-react";

export const metadata = { title: "Welcome" };

export default function Welcome() {
  return (
    <>
      <h1 className="mb-1 text-center text-2xl font-bold">Welcome</h1>
      <p className="mb-6 text-center text-sm text-slate-600">Choose how you&apos;re signing in.</p>
      <div className="space-y-3">
        <Link href="/client/login" className="flex items-center gap-4 rounded-xl border border-ivory-200 bg-ivory-50 p-4 hover:border-navy-700">
          <ShieldCheck className="size-8 text-navy-800" aria-hidden />
          <span>
            <span className="block font-serif text-lg font-semibold text-navy-900">Client Login</span>
            <span className="text-sm text-slate-600">Messages, documents, bookkeeping and tax updates</span>
          </span>
        </Link>
        <Link href="/staff/login" className="flex items-center gap-4 rounded-xl border border-ivory-200 bg-ivory-50 p-4 hover:border-navy-700">
          <Briefcase className="size-8 text-navy-800" aria-hidden />
          <span>
            <span className="block font-serif text-lg font-semibold text-navy-900">Staff Login</span>
            <span className="text-sm text-slate-600">For T. Turner &amp; Associates team members</span>
          </span>
        </Link>
      </div>
    </>
  );
}
