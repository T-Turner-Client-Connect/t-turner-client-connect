import Image from "next/image";
import { PublicFooter } from "@/components/legal-links";
import { requirePortalUser } from "@/lib/portal/session";
import { portalLogoutAction } from "@/app/actions/portal";

export default async function OnboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePortalUser();
  return (
    <div className="min-h-dvh bg-ivory-50">
      <header className="bg-navy-900 text-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <span className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-lg bg-white p-1"><Image src="/brand/logo-mark.png" alt="" width={200} height={224} className="h-auto w-7" /></span>
            <span className="font-serif font-bold tracking-wide">Account setup</span>
          </span>
          <span className="flex items-center gap-3 text-sm">
            <span className="hidden sm:inline">{user.name}</span>
            <form action={portalLogoutAction}><button className="rounded-md border border-white/30 px-3 py-1.5 hover:bg-white/10">Sign out</button></form>
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
      <PublicFooter />
    </div>
  );
}
