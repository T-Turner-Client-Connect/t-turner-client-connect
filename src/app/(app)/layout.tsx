import { PublicFooter } from "@/components/legal-links";
import { AppNav } from "@/components/nav";
import { requireUser } from "@/lib/auth/session";
import { logoutAction } from "@/app/actions/auth";
import { prisma } from "@/lib/prisma";
import { ownerNavState } from "@/lib/auth/owner";
import { readyToPublish } from "@/lib/services/social";
import Link from "next/link";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [unread, owner, ready] = await Promise.all([prisma.conversation.count({ where: { unreadByStaff: true, closedAt: null } }), ownerNavState(user), readyToPublish()]);
  return (
    <div className="min-h-dvh">
      <AppNav user={{ name: user.name, role: user.role }} signOut={logoutAction} unread={unread} owner={owner} />
      <main className="px-4 py-6 sm:px-6 lg:ml-64 lg:px-12 lg:py-10">
        <div className="mx-auto max-w-6xl">
          {ready.length > 0 && (
            // In-site reminder: due social posts, shown until each platform is marked posted.
            <Link href="/social" className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-gold-500 bg-gold-100 px-4 py-2.5 text-sm font-semibold text-navy-900" data-testid="social-reminder">
              <span>📣 {ready.length} social post{ready.length === 1 ? " is" : "s are"} ready to publish — download, copy and post, then mark posted.</span>
              <span className="underline">Open</span>
            </Link>
          )}
          {children}
        </div>
        <PublicFooter />
      </main>
    </div>
  );
}
