import { LegalLinks } from "@/components/legal-links";
import Image from "next/image";

export default function PortalPublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-ivory-100 to-ivory-50 px-4 py-10">
      <div className="w-full max-w-md">
        <Image src="/brand/logo-full.png" alt="TTurner Client Connect" width={640} height={545} priority className="mx-auto mb-2 h-auto w-48" />
        <p className="mb-6 text-center text-sm font-semibold tracking-wide text-navy-800">SECURE CLIENT PORTAL</p>
        <div className="rounded-2xl border border-navy-100 border-t-4 border-t-gold-500 bg-white p-6 shadow-sm sm:p-8">{children}</div>
        <p className="mt-6 text-center text-xs text-slate-500">T. Turner &amp; Associates, LLC · Your information is encrypted in transit and access is limited to your accounts.</p>
        <LegalLinks className="mt-3" />
      </div>
    </main>
  );
}
