import { ActionForm } from "@/components/action-form";
import { CopyCaption } from "@/components/social/composer";
import { Button } from "@/components/ui";
import { confirmManualAction } from "@/app/actions/social";
import { PLATFORM_HOME, PLATFORM_LABELS } from "@/lib/social/rules";
import { captionWithHashtags } from "@/lib/social/suggest";
import { fmtChicago } from "@/lib/tz";
import type { readyToPublish } from "@/lib/services/social";

/** The in-site reminder: everything needed to post by hand, per platform. */
export function ReadyPanel({ items }: { items: Awaited<ReturnType<typeof readyToPublish>> }) {
  if (!items.length) return null;
  return (
    <section className="mb-5 rounded-2xl border-2 border-gold-500 bg-ivory p-4" aria-labelledby="ready-heading" data-testid="ready-panel">
      <h2 id="ready-heading" className="font-serif text-lg font-bold text-navy-900">Ready to publish ({items.length})</h2>
      <p className="mb-3 text-sm text-slate-700">These reached their scheduled time. Nothing has been posted — post each one, then mark it posted.</p>
      <ul className="space-y-3">
        {items.map((t) => (
          <li key={t.id} className="rounded-xl bg-white p-3 shadow-sm">
            <p className="font-semibold">
              <a className="underline" href={`/social/${t.post.id}`}>{t.post.title}</a> · {PLATFORM_LABELS[t.platform]}
              {t.post.scheduledAt && <span className="ml-2 text-xs font-normal text-slate-600">scheduled {fmtChicago(t.post.scheduledAt)} CT</span>}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {t.mediaIds.map((m, i) => (
                <a key={m} className="rounded-lg border border-navy-100 px-3 py-2 text-sm font-semibold hover:bg-navy-50" href={`/api/files/${m}?download=1`}>Download media{t.mediaIds.length > 1 ? ` ${i + 1}` : ""}</a>
              ))}
              <CopyCaption text={captionWithHashtags(t.caption, t.hashtags)} />
              <a className="rounded-lg border border-navy-100 px-3 py-2 text-sm font-semibold hover:bg-navy-50" href={PLATFORM_HOME[t.platform]} target="_blank" rel="noopener">Open {PLATFORM_LABELS[t.platform]} ↗</a>
            </div>
            <ActionForm action={confirmManualAction.bind(null, t.post.id, t.id)} className="mt-2 flex flex-wrap gap-2">
              <input className="input min-w-0 flex-1" name="permalink" placeholder="Live post link (optional)" aria-label={`${PLATFORM_LABELS[t.platform]} post link`} />
              <Button type="submit" variant="secondary">Mark posted</Button>
            </ActionForm>
          </li>
        ))}
      </ul>
    </section>
  );
}
