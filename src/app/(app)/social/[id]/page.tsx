import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ActionForm } from "@/components/action-form";
import { CopyCaption, SocialComposer } from "@/components/social/composer";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { confirmManualAction, scheduleSocialAction, socialStepAction } from "@/app/actions/social";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { postProblems } from "@/lib/services/social";
import { PLATFORM_HOME, PLATFORM_LABELS, TARGET_STATUS_LABELS } from "@/lib/social/rules";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Social post" };

export default async function SocialPostPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const post = await prisma.socialPost.findUnique({ where: { id }, include: { targets: { orderBy: { platform: "asc" } } } });
  if (!post) notFound();
  const library = await prisma.storedFile.findMany({
    where: { kind: "FLYER", archivedAt: null },
    select: { id: true, mimeType: true, sizeBytes: true, width: true, height: true, title: true },
    orderBy: { createdAt: "desc" },
  });
  const [creator, approver] = await Promise.all([
    prisma.user.findUnique({ where: { id: post.createdById }, select: { name: true } }),
    post.approvedById ? prisma.user.findUnique({ where: { id: post.approvedById }, select: { name: true } }) : null,
  ]);
  const editable = post.status === "DRAFT" || post.status === "PENDING_APPROVAL";
  const problems = editable ? await postProblems(id) : [];
  const titles = new Map(library.map((m) => [m.id, m]));

  return (
    <>
      <PageHeader
        title={post.title}
        subtitle={`Created by ${creator?.name ?? "staff"}${approver ? ` · approved by ${approver.name} ${fmtDateTime(post.approvedAt)}` : ""}`}
      />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="1. Compose">
          <SocialComposer
            postId={id}
            initialTitle={post.title}
            initialScheduledAt={post.scheduledAt ? format(post.scheduledAt, "yyyy-MM-dd'T'HH:mm") : null}
            initialTargets={post.targets.map((t) => ({ platform: t.platform, caption: t.caption, mediaIds: t.mediaIds }))}
            library={library}
            editable={editable}
          />
        </Card>
        <div className="space-y-4">
          <Card title="2. Approve & schedule">
            <ol className="space-y-3 text-sm">
              <li className="flex items-center justify-between"><span>Status</span><Badge tone="navy">{post.status.replace(/_/g, " ").toLowerCase()}</Badge></li>
            </ol>
            {post.approvalNote && <p className="mt-2 text-sm text-amber-800">Note: {post.approvalNote}</p>}
            <div className="mt-3 space-y-3">
              {post.status === "DRAFT" && (
                <>
                  {problems.length > 0 && <Notice tone="warn">Fix {problems.length} issue(s) before sending for approval.</Notice>}
                  <ActionForm action={socialStepAction.bind(null, id, "submit")}><Button type="submit" disabled={problems.length > 0}>Send for approval</Button></ActionForm>
                </>
              )}
              {post.status === "PENDING_APPROVAL" &&
                (user.role === "ADMIN" ? (
                  <div className="space-y-2">
                    <ActionForm action={socialStepAction.bind(null, id, "approve")} className="space-y-2">
                      <input className="input" name="note" placeholder="Note (optional)" aria-label="Approval note" />
                      <Button type="submit">Approve</Button>
                    </ActionForm>
                    <ActionForm action={socialStepAction.bind(null, id, "reject")} className="flex gap-2">
                      <input className="input" name="note" placeholder="What should change?" aria-label="Changes requested" />
                      <Button type="submit" variant="secondary">Request changes</Button>
                    </ActionForm>
                  </div>
                ) : (
                  <Notice>Waiting for an Admin to approve.</Notice>
                ))}
              {post.status === "APPROVED" && (
                <ActionForm action={scheduleSocialAction.bind(null, id)} className="space-y-2">
                  <Field label="Post on"><input className="input" type="datetime-local" name="when" required defaultValue={post.scheduledAt ? format(post.scheduledAt, "yyyy-MM-dd'T'HH:mm") : ""} /></Field>
                  <Button type="submit" variant="gold">Schedule</Button>
                </ActionForm>
              )}
              {(post.status === "APPROVED" || post.status === "SCHEDULED") && (
                <ActionForm action={socialStepAction.bind(null, id, "draft")}><Button type="submit" variant="ghost">Return to draft to edit</Button></ActionForm>
              )}
            </div>
          </Card>
          {post.status !== "DRAFT" && post.status !== "PENDING_APPROVAL" && (
            <Card title="3. Publish">
              <p className="mb-3 text-sm text-slate-600">Direct publishing isn&apos;t connected. Each platform is posted manually and confirmed here.</p>
              <ul className="space-y-4">
                {post.targets.map((t) => (
                  <li key={t.id} className="rounded-lg border border-navy-100 p-3">
                    <p className="mb-2 flex items-center justify-between gap-2 font-semibold">
                      {PLATFORM_LABELS[t.platform]}
                      <Badge tone={t.status === "POSTED_MANUALLY" || t.status === "PUBLISHED" ? "green" : t.status === "REQUIRES_MANUAL_POSTING" ? "amber" : t.status === "FAILED" ? "red" : "navy"}>
                        {TARGET_STATUS_LABELS[t.status]}
                      </Badge>
                    </p>
                    {t.permalink ? (
                      <a className="text-sm underline" href={t.permalink} target="_blank" rel="noopener">View the post ↗</a>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-2">
                          {t.mediaIds.map((m, i) => (
                            <a key={m} className="rounded-lg border border-navy-100 px-3 py-2 text-sm font-semibold hover:bg-navy-50" href={`/api/files/${m}?download=1`}>
                              Download {i + 1}{titles.get(m) ? `: ${titles.get(m)!.title}` : ""}
                            </a>
                          ))}
                          <CopyCaption text={t.caption} />
                          <a className="rounded-lg border border-navy-100 px-3 py-2 text-sm font-semibold hover:bg-navy-50" href={PLATFORM_HOME[t.platform]} target="_blank" rel="noopener">Open {PLATFORM_LABELS[t.platform]} ↗</a>
                        </div>
                        <ActionForm action={confirmManualAction.bind(null, id, t.id)} className="flex flex-wrap gap-2">
                          <input className="input min-w-0 flex-1" name="permalink" placeholder={`Link to the live ${PLATFORM_LABELS[t.platform]} post`} required aria-label="Post link" />
                          <Button type="submit" variant="secondary">I posted it</Button>
                        </ActionForm>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
