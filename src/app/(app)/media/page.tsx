import { FileText } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Button, Card, EmptyState, Field, PageHeader } from "@/components/ui";
import { archiveFlyerAction, uploadFlyerAction } from "@/app/actions/files";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { formatBytes, MMS_SAFE_BYTES } from "@/lib/files";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Media library" };

export default async function FlyersPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  await requireUser();
  const archived = (await searchParams).archived === "1";
  const flyers = await prisma.storedFile.findMany({
    where: { kind: "FLYER", archivedAt: archived ? { not: null } : null },
    include: { uploadedBy: { select: { name: true } }, _count: { select: { campaigns: true } } },
    orderBy: { createdAt: "desc" },
  });
  return (
    <>
      <PageHeader title="Media library" subtitle="Promotional flyers, images and videos for email, text and social posts. Kept separate from client and tax documents." />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <p className="mb-3 text-sm">
            {archived ? <a className="underline" href="/media">← Back to library</a> : <a className="underline" href="/media?archived=1">View archived media</a>}
          </p>
          {flyers.length === 0 ? (
            <EmptyState title={archived ? "No archived media" : "No media yet"}>Upload a JPG, PNG, PDF, MP4 or MOV to get started.</EmptyState>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {flyers.map((f) => (
                <li key={f.id} className="overflow-hidden rounded-xl border border-navy-100 bg-white">
                  <a href={`/api/files/${f.id}`} target="_blank" rel="noopener" className="flex h-48 items-center justify-center bg-navy-50">
                    {f.mimeType.startsWith("video/") ? (
                      <video src={`/api/files/${f.id}`} className="h-full w-full object-contain" controls preload="metadata" />
                    ) : f.mimeType.startsWith("image/") ? (
                      // eslint-disable-next-line @next/next/no-img-element -- private, authenticated file route
                      <img src={`/api/files/${f.id}`} alt={f.title} className="h-full w-full object-contain" />
                    ) : (
                      <span className="flex flex-col items-center text-navy-900"><FileText className="size-12" aria-hidden /><span className="mt-1 text-sm font-semibold">PDF</span></span>
                    )}
                  </a>
                  <div className="space-y-1 p-3">
                    <p className="font-semibold text-navy-900">{f.title}</p>
                    <p className="text-xs text-slate-600">{f.originalName} · {formatBytes(f.sizeBytes)}{f.width ? ` · ${f.width}×${f.height}` : ""}</p>
                    <p className="text-xs text-slate-600">Added {fmtDate(f.createdAt)} by {f.uploadedBy?.name ?? "staff"}</p>
                    <div className="flex flex-wrap gap-1 pt-1">
                      {f.mimeType.startsWith("image/") && f.sizeBytes <= MMS_SAFE_BYTES ? <Badge tone="green">Text-ready (MMS)</Badge> : <Badge tone="gray">Texts get a link</Badge>}
                      {f._count.campaigns > 0 && <Badge tone="gold">Used in {f._count.campaigns} campaign{f._count.campaigns > 1 ? "s" : ""}</Badge>}
                    </div>
                    <div className="pt-2">
                      <ConfirmButton action={archiveFlyerAction.bind(null, f.id, !archived)} variant="ghost">{archived ? "Restore" : "Archive"}</ConfirmButton>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Card title="Add media">
          <ActionForm action={uploadFlyerAction} className="space-y-3" resetOnSuccess>
            <Field label="File" hint="JPG, PNG, PDF, MP4 or MOV up to 5 MB. JPG images under 600 KB can go out as picture texts; Instagram and TikTok need JPG images.">
              <input className="input" type="file" name="file" accept="image/png,image/jpeg,application/pdf,video/mp4,video/quicktime" required />
            </Field>
            <Field label="Title"><input className="input" name="title" placeholder="e.g. 2026 Tax Season Flyer" /></Field>
            <Button type="submit">Upload</Button>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
