import { AppNav } from "@/components/nav";
import { requireUser } from "@/lib/auth/session";
import { logoutAction } from "@/app/actions/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div className="min-h-dvh">
      <AppNav user={{ name: user.name, role: user.role }} signOut={logoutAction} />
      <main className="px-4 py-6 sm:px-6 lg:ml-64 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
