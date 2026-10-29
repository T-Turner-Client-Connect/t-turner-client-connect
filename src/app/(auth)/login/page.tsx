import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Button, Field, Notice } from "@/components/ui";
import { loginAction } from "@/app/actions/auth";
import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reset?: string }> }) {
  if (await getCurrentUser()) redirect("/");
  const { reset } = await searchParams;
  const noUsers = (await prisma.user.count()) === 0;
  return (
    <>
      <h1 className="mb-4 text-2xl font-bold">Staff sign in</h1>
      {reset && <div className="mb-4"><Notice tone="success">Password updated. Sign in with your new password.</Notice></div>}
      {noUsers && (
        <div className="mb-4">
          <Notice title="First time here?">
            No staff accounts exist yet. <Link className="font-semibold underline" href="/setup">Create the first Admin</Link>.
          </Notice>
        </div>
      )}
      <ActionForm action={loginAction} className="space-y-4" showSuccess={false}>
        <Field label="Email">
          <input className="input" type="email" name="email" autoComplete="username" required />
        </Field>
        <Field label="Password">
          <input className="input" type="password" name="password" autoComplete="current-password" required />
        </Field>
        <Button type="submit" className="w-full">Sign in</Button>
      </ActionForm>
      <p className="mt-4 text-center text-sm">
        <Link href="/forgot-password" className="text-navy-800 underline">Forgot your password?</Link>
      </p>
    </>
  );
}
