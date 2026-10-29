import Image from "next/image";
import Link from "next/link";
import { PublicFooter } from "@/components/legal-links";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-ivory-100">
      <header className="bg-navy-900">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
          <Link href="/welcome" className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-xl bg-ivory-50 p-1">
              <Image src="/brand/logo-mark.png" alt="" width={200} height={224} className="h-auto w-8" />
            </span>
            <span className="leading-tight">
              <span className="block font-serif text-lg font-bold tracking-[0.08em] text-white">TTURNER</span>
              <span className="block text-[10.5px] font-semibold tracking-[0.2em] text-gold-500">CLIENT CONNECT</span>
            </span>
          </Link>
          <Link href="/client/login" className="rounded-lg border border-white/30 px-3 py-1.5 text-sm font-semibold text-white hover:bg-white/10">Client Login</Link>
        </div>
        <div className="h-1 bg-gradient-to-r from-gold-500 to-gold-300" />
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:py-12">{children}</main>
      <PublicFooter dark />
    </div>
  );
}
