import { redirect } from "next/navigation";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "New message" };

async function pick(fd: FormData) {
  "use server";
  await requireUser();
  const id = String(fd.get("clientId") ?? "");
  if (id) redirect(`/clients/${id}?tab=messages`);
}

export default async function NewConversation() {
  await requireUser();
  const clients = await prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true, businessName: true }, orderBy: { displayName: "asc" }, take: 5000 });
  return (
    <>
      <PageHeader title="New message" subtitle="Choose the client. You'll pick Portal, Email, Text or an internal note on their record, so the right recipient and thread are always clear." />
      <Card className="max-w-xl">
        <form action={pick} className="space-y-4">
          <Field label="Client">
            <select className="input" name="clientId" required>
              <option value="">Choose a client…</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.displayName}{c.businessName && c.businessName !== c.displayName ? ` — ${c.businessName}` : ""}</option>)}
            </select>
          </Field>
          <Button type="submit">Continue</Button>
        </form>
      </Card>
    </>
  );
}
