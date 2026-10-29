"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import type { SocialPlatform } from "@prisma/client";
import { Badge, Button, Field, Notice } from "@/components/ui";
import { saveSocialDraftAction } from "@/app/actions/social";
import { PLATFORM_LABELS, validateTarget, type MediaInfo } from "@/lib/social/rules";

type Target = { platform: SocialPlatform; caption: string; mediaIds: string[] };
const ALL: SocialPlatform[] = ["FACEBOOK", "INSTAGRAM", "TIKTOK"];

function Preview({ platform, caption, media }: { platform: SocialPlatform; caption: string; media: MediaInfo[] }) {
  const first = media[0];
  const visual = first ? (
    first.mimeType.startsWith("video/") ? (
      <video src={`/api/files/${first.id}`} className="w-full bg-black" muted preload="metadata" />
    ) : first.mimeType.startsWith("image/") ? (
      // eslint-disable-next-line @next/next/no-img-element -- private, authenticated file route
      <img src={`/api/files/${first.id}`} alt={first.title} className="w-full object-cover" />
    ) : (
      <div className="flex h-40 items-center justify-center bg-slate-100 text-sm text-slate-500">PDF can&apos;t be posted</div>
    )
  ) : null;
  return (
    <div className={clsx("overflow-hidden rounded-xl border bg-white shadow-sm", platform === "TIKTOK" ? "mx-auto max-w-[220px] border-slate-800 bg-black text-white" : "border-slate-200")}>
      <div className={clsx("flex items-center gap-2 px-3 py-2 text-sm font-semibold", platform === "TIKTOK" && "order-last")}>
        <span className="flex size-7 items-center justify-center rounded-full bg-navy-900 text-[10px] text-gold-500">TT</span>
        T. Turner &amp; Associates
      </div>
      {platform === "FACEBOOK" && caption && <p className="whitespace-pre-wrap px-3 pb-2 text-sm">{caption}</p>}
      {visual}
      {media.length > 1 && <p className="px-3 pt-1 text-xs text-slate-500">+{media.length - 1} more</p>}
      {platform !== "FACEBOOK" && caption && <p className={clsx("whitespace-pre-wrap px-3 py-2 text-sm", platform === "TIKTOK" && "text-white")}>{caption}</p>}
    </div>
  );
}

export function SocialComposer({
  postId,
  initialTitle,
  initialScheduledAt,
  initialTargets,
  library,
  editable,
}: {
  postId: string;
  initialTitle: string;
  initialScheduledAt: string | null;
  initialTargets: Target[];
  library: MediaInfo[];
  editable: boolean;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [when, setWhen] = useState(initialScheduledAt ?? "");
  const [targets, setTargets] = useState<Target[]>(initialTargets);
  const [active, setActive] = useState<SocialPlatform>(initialTargets[0]?.platform ?? "FACEBOOK");
  const [msg, setMsg] = useState<{ ok?: string; error?: string } | null>(null);
  const [pending, start] = useTransition();
  const byId = useMemo(() => new Map(library.map((m) => [m.id, m])), [library]);

  const current = targets.find((t) => t.platform === active);
  const togglePlatform = (p: SocialPlatform, on: boolean) => {
    if (on) {
      const base = targets[0];
      setTargets([...targets, { platform: p, caption: base?.caption ?? "", mediaIds: base?.mediaIds ?? [] }]);
      setActive(p);
    } else {
      const next = targets.filter((t) => t.platform !== p);
      setTargets(next);
      if (active === p && next[0]) setActive(next[0].platform);
    }
  };
  const update = (patch: Partial<Target>) => setTargets(targets.map((t) => (t.platform === active ? { ...t, ...patch } : t)));

  function save() {
    start(async () => {
      const res = await saveSocialDraftAction(postId, { title, scheduledAt: when || null, targets });
      setMsg(res);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Working title" className="sm:col-span-2"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} disabled={!editable} /></Field>
        <Field label="Planned date (for the calendar)"><input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} disabled={!editable} /></Field>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-navy-900">Platforms</legend>
        <div className="flex flex-wrap gap-2">
          {ALL.map((p) => (
            <label key={p} className="flex items-center gap-2 rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm">
              <input type="checkbox" className="size-4 accent-navy-900" checked={targets.some((t) => t.platform === p)} disabled={!editable} onChange={(e) => togglePlatform(p, e.target.checked)} />
              {PLATFORM_LABELS[p]}
            </label>
          ))}
        </div>
      </fieldset>

      {targets.length > 0 && (
        <>
          <div role="tablist" className="flex gap-1 border-b border-navy-100">
            {targets.map((t) => {
              const problems = validateTarget(t.platform, t.caption, t.mediaIds.map((id) => byId.get(id)!).filter(Boolean));
              return (
                <button
                  key={t.platform}
                  role="tab"
                  aria-selected={active === t.platform}
                  onClick={() => setActive(t.platform)}
                  className={clsx("-mb-px rounded-t-lg border px-4 py-2 text-sm font-semibold", active === t.platform ? "border-navy-100 border-b-white bg-white text-navy-900" : "border-transparent text-slate-600")}
                >
                  {PLATFORM_LABELS[t.platform]} {problems.length > 0 && <Badge tone="red">{problems.length}</Badge>}
                </button>
              );
            })}
          </div>
          {current && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-3">
                <Field label={`${PLATFORM_LABELS[active]} caption`} hint={`${current.caption.length.toLocaleString()} characters`}>
                  <textarea className="input" rows={7} value={current.caption} onChange={(e) => update({ caption: e.target.value })} disabled={!editable} />
                </Field>
                <fieldset>
                  <legend className="mb-1 text-sm font-semibold text-navy-900">Media (in order)</legend>
                  {library.length === 0 ? (
                    <p className="text-sm text-slate-600">Add images or videos to the media library first.</p>
                  ) : (
                    <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
                      {library.map((m) => {
                        const idx = current.mediaIds.indexOf(m.id);
                        return (
                          <label key={m.id} className={clsx("relative cursor-pointer overflow-hidden rounded-lg border-2", idx >= 0 ? "border-gold-500" : "border-transparent")}>
                            <input
                              type="checkbox"
                              className="sr-only"
                              checked={idx >= 0}
                              disabled={!editable}
                              onChange={(e) => update({ mediaIds: e.target.checked ? [...current.mediaIds, m.id] : current.mediaIds.filter((x) => x !== m.id) })}
                            />
                            {m.mimeType.startsWith("image/") ? (
                              // eslint-disable-next-line @next/next/no-img-element -- private, authenticated file route
                              <img src={`/api/files/${m.id}`} alt={m.title} className="aspect-square w-full object-cover" />
                            ) : (
                              <span className="flex aspect-square items-center justify-center bg-navy-50 p-1 text-center text-xs">{m.mimeType.startsWith("video/") ? "🎬 " : "📄 "}{m.title}</span>
                            )}
                            {idx >= 0 && <span className="absolute left-1 top-1 rounded-full bg-gold-500 px-1.5 text-xs font-bold text-navy-950">{idx + 1}</span>}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </fieldset>
                {(() => {
                  const problems = validateTarget(active, current.caption, current.mediaIds.map((id) => byId.get(id)!).filter(Boolean));
                  return problems.length ? (
                    <Notice tone="error" title={`${PLATFORM_LABELS[active]} requirements`}><ul className="list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul></Notice>
                  ) : (
                    <Notice tone="success">Meets {PLATFORM_LABELS[active]}&apos;s requirements.</Notice>
                  );
                })()}
              </div>
              <div>
                <p className="mb-2 text-sm font-semibold text-navy-900">Preview</p>
                <Preview platform={active} caption={current.caption} media={current.mediaIds.map((id) => byId.get(id)!).filter(Boolean)} />
                <p className="mt-2 text-xs text-slate-500">Approximate preview. Each platform crops and styles posts its own way.</p>
              </div>
            </div>
          )}
        </>
      )}
      {editable && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save draft"}</Button>
          {msg?.error && <span role="alert" className="text-sm text-red-700">{msg.error}</span>}
          {msg?.ok && <span role="status" className="text-sm text-emerald-700">{msg.ok}</span>}
        </div>
      )}
    </div>
  );
}

export function CopyCaption({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "Copied ✓" : "Copy caption"}
    </Button>
  );
}
