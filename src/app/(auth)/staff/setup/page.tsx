import { ActionForm } from "@/components/action-form";
import { Button, Field, Notice } from "@/components/ui";
import { setupAction } from "@/app/actions/auth";
import { connection } from "next/server";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "First-time setup" };

export default async function SetupPage() {
  await connection(); // account count and SETUP_TOKEN must be read per request
  const done = (await prisma.user.count()) > 0;
  if (done) {
    return <Notice title="Setup is complete">Staff accounts already exist. New staff join by invitation from an Admin.</Notice>;
  }
  const configured = (process.env.SETUP_TOKEN?.length ?? 0) >= 16;
  return (
    <>
      <h1 className="mb-2 text-2xl font-bold">Create the first Admin</h1>
      <p className="mb-4 text-sm text-slate-600">This page only works once, while no accounts exist. Everyone else joins by invitation.</p>
      {!configured ? (
        <Notice tone="warn" title="Setup code not configured">
          Add a <code>SETUP_TOKEN</code> environment variable (16+ random characters) in Netlify, redeploy, then return here.
        </Notice>
      ) : (
        <ActionForm action={setupAction} className="space-y-4" showSuccess={false}>
          <Field label="Setup code" hint="The SETUP_TOKEN value from your Netlify environment variables.">
            <input className="input" type="password" name="setupToken" required autoComplete="off" />
          </Field>
          <Field label="Your name"><input className="input" name="name" required autoComplete="name" /></Field>
          <Field label="Email"><input className="input" type="email" name="email" required autoComplete="username" /></Field>
          <Field label="Password" hint="At least 12 characters, with letters and numbers or symbols.">
            <input className="input" type="password" name="password" required minLength={12} autoComplete="new-password" />
          </Field>
          <Field label="Confirm password"><input className="input" type="password" name="confirm" required autoComplete="new-password" /></Field>
          <Button type="submit" className="w-full">Create Admin account</Button>
        </ActionForm>
      )}
    </>
  );
}
