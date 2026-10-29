import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { CopyCaption, SocialComposer } from "@/components/social/composer";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { confirmManualAction, rescheduleSocialAction, socialStepAction, uploadSocialMediaAction } from "@/app/actions/social";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { postClaimFlags, postProblems } from "@/lib/services/social";
import { PLATFORM_HOME, PLATFORM_LABELS, POST_STATUS, TARGET_STATUS_LABELS } from "@/lib/social/rules";
import { captionWithHashtags, CATEGORY_LABELS, TIME_SUGGESTION_NOTE } from "@/lib/social/suggest";
import { fmtChicago, utcToChicagoLocal } from "@/lib/tz";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Social post" };

const ACTION_LABELS: Record<string, string> = {
  created: "Created",
  suggested_from_topic: "Suggested from an approved topic",
  edited: "Edited",
  regenerated: "Wording regenerated",
  rescheduled: "Time changed",
  submitted: "Sent for approval",
  approved: "Approved & scheduled",
  approved_claims_verified: "Approved & scheduled (flagged wording verified)",
  changes_requested: "Sent back with changes requested",
  returned_to_draft: "Returned to draft",
  scheduled: "Scheduled",
};
const actionLabel = (a: string) =>
  ACTION_LABELS[a] ??
  (a.endsWith("_returned_to_awaiting_approval") ? `${ACTION_LABELS[a.replace("_returned_to_awaiting_approval", "")] ?? "Changed"} — back to Awaiting approval` : a.startsWith("posted_manually_") ? `Marked posted on ${PLATFORM_LABELS[a.replace("posted_manually_", "").toUpperCase() as keyof typeof PLATFORM_LABELS]}` : a);

export default async function SocialPostPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const post = await prisma.socialPost.findUnique({ where: { id }, include: { targets: { orderBy: { platform: "asc" } }, topic: true, revisions: { orderBy: { createdAt: "desc" }, take: 30 } } });
  if (!post) notFound();
  const library = await prisma.storedFile.findMany({
    where: { kind: "FLYER", archivedAt: null },
    select: { id: true, mimeType: true, sizeBytes: true, width: true, height: true, title: true },
    orderBy: { createdAt: "desc" },
  });
  const people = new Map((await prisma.user.findMany({ where: { id: { in: [post.createdById, post.approvedById ?? "", ...post.revisions.map((r) => r.actorId)] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const editable = post.status !== "COMPLETED" && post.status !== "CANCELLED";
  const approved = post.status === "APPROVED" || post.status === "SCHEDULED";
  const [problems, flags] = await Promise.all([postProblems(id), postClaimFlags(id)]);
  const titles = new Map(library.map((m) => [m.id, m]));
  const status = POST_STATUS[post.status];

  return (
    <>
      <PageHeader
        title={post.title}
        subtitle={
          <>
            <Badge tone={status.tone}>{status.label}</Badge>
            {post.scheduledAt && <span className="ml-2">Post on {fmtChicago(post.scheduledAt)} CT</span>}
            {post.timeSuggested && <span className="ml-2 text-xs">(recommended time)</span>}
            {post.topic && <span className="ml-2 text-xs">· from topic “{post.topic.title}” ({CATEGORY_LABELS[post.topic.category]})</span>}
          </>
        }
      />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card title="Compose">
            <SocialComposer
              postId={id}
              initialTitle={post.title}
              initialScheduledAt={post.scheduledAt ? utcToChicagoLocal(post.scheduledAt) : null}
              initialTimeSuggested={post.timeSuggested}
              initialTargets={post.targets.map((t) => ({ platform: t.platform, caption: t.caption, hashtags: t.hashtags.map((h) => `#${h}`).join(" "), mediaIds: t.mediaIds, locked: t.status === "POSTED_MANUALLY" || t.status === "PUBLISHED" }))}
              library={library}
              editable={editable}
              approved={approved}
            />
          </Card>
          {editable && (
            <Card title="Add media to the marketing library">
              <ActionForm action={uploadSocialMediaAction.bind(null, id)} className="flex flex-wrap items-end gap-2" resetOnSuccess>
                <Field label="Flyer, photo or video (PNG, JPG, MP4, MOV — up to 5 MB)"><input className="input" type="file" name="file" accept="image/png,image/jpeg,video/mp4,video/quicktime" required /></Field>
                <Field label="Title (optional)"><input className="input" name="title" /></Field>
                <Button type="submit" variant="secondary">Upload</Button>
              </ActionForm>
              <p className="mt-2 text-xs text-slate-600">Marketing media only. Client documents are kept in a separate private store and can&apos;t be attached to posts.</p>
            </Card>
          )}
        </div>
        <div className="space-y-4">
          <Card title="Approval">
            {post.approvalNote && <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">Note: {post.approvalNote}</p>}
            {post.approvedAt && <p className="mb-2 text-sm text-slate-600">Approved by {people.get(post.approvedById ?? "") ?? "staff"} {fmtDateTime(post.approvedAt)}{post.claimsVerifiedAt && " · flagged wording verified"}</p>}
            <div className="space-y-3">
              {post.status === "DRAFT" && (
                <>
                  {problems.length > 0 && <Notice tone="warn" title="Before sending for approval"><ul className="list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul></Notice>}
                  <ActionForm action={socialStepAction.bind(null, id, "submit")}><Button type="submit" disabled={problems.length > 0}>Send for approval</Button></ActionForm>
                </>
              )}
              {post.status === "PENDING_APPROVAL" && (
                <div className="space-y-3">
                  <ActionForm action={socialStepAction.bind(null, id, "approve")} className="space-y-2">
                    {flags.length > 0 && (
                      <label className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                        <input type="checkbox" name="claimsVerified" className="mt-1" />
                        <span>I verified the flagged wording ({flags.map((f) => `“${f.text}”`).join(", ")}) is accurate and current.</span>
                      </label>
                    )}
                    <input className="input" name="note" placeholder="Note (optional)" aria-label="Approval note" />
                    <Button type="submit" disabled={problems.length > 0}>Approve & schedule</Button>
                  </ActionForm>
                  <ActionForm action={socialStepAction.bind(null, id, "reject")} className="flex gap-2">
                    <input className="input" name="note" placeholder="What should change?" aria-label="Changes requested" />
                    <Button type="submit" variant="secondary">Reject</Button>
                  </ActionForm>
                </div>
              )}
              {post.topic && editable && (
                <ActionForm action={socialStepAction.bind(null, id, "regenerate")} confirm={approved ? "Regenerating changes the wording and sends this post back to Awaiting approval. Continue?" : undefined}>
                  <Button type="submit" variant="ghost">Regenerate wording from topic</Button>
                </ActionForm>
              )}
              {post.status === "SCHEDULED" && (
                <ActionForm action={rescheduleSocialAction.bind(null, id)} className="space-y-2">
                  <Field label="Change time (Central)" hint="A new time needs approval again."><input className="input" type="datetime-local" name="when" required defaultValue={post.scheduledAt ? utcToChicagoLocal(post.scheduledAt) : ""} /></Field>
                  <Button type="submit" variant="secondary">Change time</Button>
                </ActionForm>
              )}
              {approved && <ActionForm action={socialStepAction.bind(null, id, "draft")}><Button type="submit" variant="ghost">Return to draft</Button></ActionForm>}
            </div>
            {post.timeSuggested && <p className="mt-3 text-xs text-slate-600">{TIME_SUGGESTION_NOTE}</p>}
          </Card>

          {post.status !== "DRAFT" && post.status !== "PENDING_APPROVAL" && (
            <Card title="Publish (manual)">
              <p className="mb-3 text-sm text-slate-600">Nothing posts automatically. When it&apos;s time you&apos;ll see a reminder; post on each platform, then mark it posted here.</p>
              <ul className="space-y-4">
                {post.targets.map((t) => (
                  <li key={t.id} className="rounded-lg border border-navy-100 p-3" data-platform={t.platform}>
                    <p className="mb-2 flex items-center justify-between gap-2 font-semibold">
                      {PLATFORM_LABELS[t.platform]}
                      <Badge tone={t.status === "POSTED_MANUALLY" || t.status === "PUBLISHED" ? "green" : t.status === "REQUIRES_MANUAL_POSTING" ? "amber" : "navy"}>{TARGET_STATUS_LABELS[t.status]}</Badge>
                    </p>
                    {t.status === "POSTED_MANUALLY" || t.status === "PUBLISHED" ? (
                      <p className="text-sm">Posted {fmtDateTime(t.publishedAt)}{t.permalink ? <> · <a className="underline" href={t.permalink} target="_blank" rel="noopener">view post ↗</a></> : " (no link saved)"}</p>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-2">
                          {t.mediaIds.map((m, i) => (
                            <a key={m} className="rounded-lg border border-navy-100 px-3 py-2 text-sm font-semibold hover:bg-navy-50" href={`/api/files/${m}?download=1`}>
                              Download media {t.mediaIds.length > 1 ? i + 1 : ""}{titles.get(m) ? `: ${titles.get(m)!.title}` : ""}
                            </a>
                          ))}
                          <CopyCaption text={captionWithHashtags(t.caption, t.hashtags)} />
                          <a className="rounded-lg border border-navy-100 px-3 py-2 text-sm font-semibold hover:bg-navy-50" href={PLATFORM_HOME[t.platform]} target="_blank" rel="noopener">Open {PLATFORM_LABELS[t.platform]} ↗</a>
                        </div>
                        <ActionForm action={confirmManualAction.bind(null, id, t.id)} className="flex flex-wrap gap-2">
                          <input className="input min-w-0 flex-1" name="permalink" placeholder={`Link to the live ${PLATFORM_LABELS[t.platform]} post (optional)`} aria-label={`${PLATFORM_LABELS[t.platform]} post link`} />
                          <Button type="submit" variant="secondary">Mark posted</Button>
                        </ActionForm>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="History">
            <ol className="space-y-1.5 text-sm" data-testid="history">
              {post.revisions.map((r) => (
                <li key={r.id} className="flex justify-between gap-2"><span>{actionLabel(r.action)} · {people.get(r.actorId) ?? "staff"}</span><span className="shrink-0 text-xs text-slate-600">{fmtDateTime(r.createdAt)}</span></li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
