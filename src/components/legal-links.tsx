import Link from "next/link";
import clsx from "clsx";
import { BUSINESS } from "@/lib/business";

/** Public policy links shown in every footer and on the sign-in pages. */
export function LegalLinks({ className, dark }: { className?: string; dark?: boolean }) {
  const link = clsx("underline-offset-2 hover:underline", dark ? "text-navy-100 hover:text-white" : "text-navy-800");
  return (
    <nav aria-label="Policies" className={clsx("flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs", className)}>
      <Link href="/sms-consent" className={link}>SMS Consent</Link>
      <Link href="/privacy-policy" className={link}>Privacy Policy</Link>
      <Link href="/terms" className={link}>Terms &amp; Conditions</Link>
    </nav>
  );
}

export function PublicFooter({ dark }: { dark?: boolean }) {
  return (
    <footer className={clsx("px-4 py-6 text-center text-xs", dark ? "bg-navy-950 text-navy-100" : "text-slate-600")}>
      <LegalLinks dark={dark} />
      <p className="mt-2">{BUSINESS.platformIdentity}</p>
    </footer>
  );
}
