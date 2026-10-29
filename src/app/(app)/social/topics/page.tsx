import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, Notice, PageHeader } from "@/components/ui";
import { SocialViewTabs } from "@/components/social/view-tabs";
import { draftFromTopicAction, saveTopicAction, topicStepAction } from "@/app/actions/social";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { PLATFORM_LABELS } from "@/lib/social/rules";
import { CATEGORY_LABELS } from "@/lib/social/suggest";

export const metadata = { title: "Content topics" };

export default async function TopicsPage() {
  const user = await requireUser();
  const topics = await prisma.contentTopic.findMany({ where: { archivedAt: null }, orderBy: [{ approvedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }] });
  return (
    <>
      <PageHeader title="Social media" subtitle="Approved talking points the suggestion helper may use." />
      <SocialViewTabs active="topics" />
      <div className="mb-4">
        <Notice title="How suggestions stay accurate">
          Suggested captions are built only from a topic&apos;s approved message, its call to action and hashtags, plus neutral openers like &ldquo;Bookkeeping tip:&rdquo;. They never add
          prices, promotions, deadlines, testimonials, office hours or tax facts. Holiday and announcement dates come only from the date you enter. Any wording with dates, tax
          rules, prices, guarantees, reviews or hours is flagged and must be verified before a post can be approved. {user.role === "ADMIN" ? "" : "An Admin approves topics before suggestions use them."}
        </Notice>
      </div>
      <div className="grid gap-4 lg:grid-cols-[2fr_3fr]">
        <Card title="Add a topic">
          <ActionForm action={saveTopicAction.bind(null, null)} className="space-y-3" resetOnSuccess>
            <Field label="Category">
              <select className="input" name="category" required>{Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </Field>
            <Field label="Title"><input className="input" name="title" required placeholder="e.g. Monthly bookkeeping reconciliation" /></Field>
            <Field label="Approved message" hint="The facts and wording suggestions may use. Write it exactly as you'd want it said."><textarea className="input" name="keyMessage" rows={4} required /></Field>
            <Field label="Call to action (optional)" hint="Default: “Questions? Send us a message through your client portal.”"><input className="input" name="callToAction" /></Field>
            <Field label="Hashtags (optional)"><input className="input" name="hashtags" placeholder="#SmallBusiness #Bookkeeping" /></Field>
            <Field label="Date (holidays and announcements only)" hint="Enter the real date. Nothing is assumed."><input className="input" type="date" name="eventDate" /></Field>
            <Button type="submit">Save topic</Button>
          </ActionForm>
        </Card>
        <Card title="Topics">
          {topics.length === 0 ? (
            <EmptyState title="No topics yet">Add the services, tips and announcements you want to post about.</EmptyState>
          ) : (
            <ul className="divide-y divide-navy-100">
              {topics.map((t) => (
                <li key={t.id} className="py-3" data-topic={t.title}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold">{t.title} <span className="text-sm font-normal text-slate-600">· {CATEGORY_LABELS[t.category]}{t.eventDate && ` · ${t.eventDate.toISOString().slice(0, 10)}`}</span></p>
                    {t.approvedAt ? <Badge tone="green">Approved</Badge> : <Badge tone="gold">Needs approval</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-slate-700">{t.keyMessage}</p>
                  {t.hashtags.length > 0 && <p className="text-xs text-slate-600">{t.hashtags.map((h) => `#${h}`).join(" ")}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {!t.approvedAt && user.role === "ADMIN" && <ActionForm action={topicStepAction.bind(null, t.id, "approve")}><Button variant="secondary">Approve</Button></ActionForm>}
                    {t.approvedAt && (
                      <ActionForm action={draftFromTopicAction} className="flex flex-wrap items-center gap-2 text-sm">
                        <input type="hidden" name="topicId" value={t.id} />
                        {(["FACEBOOK", "INSTAGRAM", "TIKTOK"] as const).map((p) => <label key={p} className="flex items-center gap-1"><input type="checkbox" name="platform" value={p} defaultChecked={p !== "TIKTOK"} /> {PLATFORM_LABELS[p]}</label>)}
                        <Button type="submit" variant="secondary">Draft a post</Button>
                      </ActionForm>
                    )}
                    <ActionForm action={topicStepAction.bind(null, t.id, "archive")} confirm="Archive this topic? Existing posts keep their wording."><Button variant="ghost">Archive</Button></ActionForm>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
