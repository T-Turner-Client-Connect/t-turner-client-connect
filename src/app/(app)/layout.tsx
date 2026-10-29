import { PublicFooter } from "@/components/legal-links";
import { AppNav } from "@/components/nav";
import { requireUser } from "@/lib/auth/session";
import { logoutAction } from "@/app/actions/auth";
import { prisma } from "@/lib/prisma";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const unread = await prisma.conversation.count({ where: { unreadByStaff: true, closedAt: null } });
  return (
    <div className="min-h-dvh">
      <AppNav user={{ name: user.name, role: user.role }} signOut={logoutAction} unread={unread} />
      <main className="px-4 py-6 sm:px-6 lg:ml-64 lg:px-12 lg:py-10">
        <div className="mx-auto max-w-6xl">{children}</div>
        <PublicFooter />
      </main>
    </div>
  );
}
