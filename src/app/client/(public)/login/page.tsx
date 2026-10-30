import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Button, Field, Notice } from "@/components/ui";
import { portalLoginAction } from "@/app/actions/portal";
import { getPortalUser } from "@/lib/portal/session";

export const metadata = { title: "Client portal sign in" };

export default async function PortalLogin({ searchParams }: { searchParams: Promise<{ reset?: string }> }) {
  if (await getPortalUser()) redirect("/client");
  const { reset } = await searchParams;
  return (
    <>
      <h1 className="mb-1 text-2xl font-bold">Client Login</h1>
      <p className="mb-4 text-sm text-slate-600">Welcome back. Sign in to your secure portal.</p>
      {reset && <div className="mb-4"><Notice tone="success">Password updated. Sign in with your new password.</Notice></div>}
      <ActionForm action={portalLoginAction} className="space-y-4" showSuccess={false}>
        <Field label="Email"><input className="input" type="email" name="email" autoComplete="username" required /></Field>
        <Field label="Password"><input className="input" type="password" name="password" autoComplete="current-password" required /></Field>
        <Button type="submit" className="w-full">Sign in</Button>
      </ActionForm>
      <p className="mt-4 text-center text-sm"><Link href="/client/forgot-password" className="underline">Forgot your password?</Link></p>
      <div className="mt-6 border-t border-navy-100 pt-5 text-center">
        <p className="mb-2 text-sm font-semibold text-navy-900">New to TTurner &amp; Associates?</p>
        <Link href="/client/signup" className="block w-full rounded-lg border-2 border-gold-500 bg-ivory px-4 py-2.5 font-semibold text-navy-900 hover:bg-gold-100">Create Client Account</Link>
        <p className="mt-3 text-sm"><Link href="/client/activate" className="underline">Already a client? Activate your portal.</Link></p>
      </div>
    </>
  );
}
