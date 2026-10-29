import Link from "next/link";
import { Badge, Card, EmptyState } from "@/components/ui";
import type { loadPortalHome } from "@/lib/portal/views";
import { MONTHS } from "@/lib/services/bookkeeping";
import { fmtDate } from "@/lib/format";

type Home = Awaited<ReturnType<typeof loadPortalHome>>;

export function PortalHomeView({ data, linkFor, q, readOnly }: { data: Home; linkFor: (id: string) => string; q: string; readOnly?: boolean }) {
  const nothing = !data.updates.length && !data.unread && !data.readyPeriods.length && !data.newDocs.length && !data.requests.length && !data.deadlines.length && !data.contracts.length && !data.signatures.length;
  const actions = [
    data.requests.length && { href: `/client/bookkeeping${q}`, label: "Upload documents", detail: `${data.requests.length} requested${data.requests[0]?.dueAt ? ` · first due ${fmtDate(data.requests[0].dueAt)}` : ""}` },
    data.readyPeriods.length && { href: `/client/bookkeeping${q}`, label: "Review report", detail: `${MONTHS[data.readyPeriods[0].month - 1]} ${data.readyPeriods[0].year} is ready` },
    data.contracts.length && { href: `/client/contracts/${data.contracts[0].id}${q}`, label: "Complete contract", detail: data.contracts[0].title },
    data.signatures.length && { href: `/client/contracts${q}`, label: "Sign documents", detail: data.signatures[0].title },
    data.unread && { href: `/client/messages${q}`, label: "Read messages", detail: `${data.unread} new` },
  ].filter(Boolean) as { href: string; label: string; detail: string }[];
  return (
    <div className="space-y-5">
      {actions.length > 0 && (
        <section aria-label="Your next steps" className="rounded-2xl bg-navy-900 p-5 text-white shadow-lg">
          <h2 className="mb-3 font-serif text-xl text-white">Your next steps</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {actions.map((a) => (
              <Link key={a.label} href={readOnly ? "#" : a.href} className="rounded-xl bg-white/10 p-4 hover:bg-white/15">
                <span className="block font-semibold text-white">{a.label} →</span>
                <span className="text-sm text-navy-100">{a.detail}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Link href={`/client/messages${q}`} className="rounded-2xl border border-ivory-200 border-t-4 border-t-gold-500 bg-white p-4 shadow-sm"><p className="text-sm text-slate-600">Unread messages</p><p className="font-serif text-3xl font-bold text-navy-900">{data.unread}</p></Link>
        <Link href={`/client/documents${q}`} className="rounded-2xl border border-ivory-200 border-t-4 border-t-gold-500 bg-white p-4 shadow-sm"><p className="text-sm text-slate-600">New documents</p><p className="font-serif text-3xl font-bold text-navy-900">{data.newDocs.length}</p></Link>
        <Link href={`/client/bookkeeping${q}`} className="rounded-2xl border border-ivory-200 border-t-4 border-t-gold-500 bg-white p-4 shadow-sm"><p className="text-sm text-slate-600">Requested from you</p><p className="font-serif text-3xl font-bold text-navy-900">{data.requests.length}</p></Link>
        <Link href={`/client/contracts${q}`} className="rounded-2xl border border-ivory-200 border-t-4 border-t-gold-500 bg-white p-4 shadow-sm"><p className="text-sm text-slate-600">To sign or complete</p><p className="font-serif text-3xl font-bold text-navy-900">{data.contracts.length + data.signatures.length}</p></Link>
      </div>
      {nothing && <EmptyState title="You're all caught up">New messages, documents and requests from T. Turner &amp; Associates will appear here.</EmptyState>}
      <div className="grid gap-4 lg:grid-cols-2">
        {data.updates.length > 0 && (
          <Card title="Updates & announcements" className="lg:col-span-2">
            <ul className="space-y-3">
              {data.updates.map((u) => (
                <li key={u.id} className="border-l-4 border-gold-500 pl-3">
                  <p className="font-semibold text-navy-900">{u.title} {!u.clientId && <Badge tone="gray">Announcement</Badge>}</p>
                  <p className="whitespace-pre-wrap text-sm text-slate-700">{u.body}</p>
                  <p className="text-xs text-slate-500">{fmtDate(u.publishedAt)}</p>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {data.requests.length > 0 && (
          <Card title="Documents we need from you">
            <ul className="divide-y divide-navy-100 text-sm">
              {data.requests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><strong>{r.title}</strong>{r.instructions && <span className="block text-slate-600">{r.instructions}</span>}</span>
                  {r.dueAt && <Badge tone={r.dueAt < new Date() ? "red" : "amber"}>Due {fmtDate(r.dueAt)}</Badge>}
                </li>
              ))}
            </ul>
            {!readOnly && <Link href={`/client/bookkeeping${q}`} className="mt-2 inline-block text-sm font-semibold underline">Upload now</Link>}
          </Card>
        )}
        {(data.readyPeriods.length > 0 || data.newDocs.length > 0) && (
          <Card title="Ready for your review">
            <ul className="space-y-1 text-sm">
              {data.readyPeriods.map((p) => <li key={p.id}><Badge tone="gold">Bookkeeping</Badge> {MONTHS[p.month - 1]} {p.year} is ready for review</li>)}
              {data.newDocs.map((d) => <li key={d.id}><a className="underline" href={linkFor(d.id)} target="_blank" rel="noopener">{d.title}</a> <span className="text-slate-500">· {fmtDate(d.publishedAt)}</span></li>)}
            </ul>
          </Card>
        )}
        {(data.contracts.length > 0 || data.signatures.length > 0) && (
          <Card title="Waiting for your signature or form">
            <ul className="space-y-1 text-sm">
              {data.contracts.map((c) => <li key={c.id}><Link className="underline" href={`/client/contracts/${c.id}${q}`}>{c.title}</Link>{c.dueAt && ` · due ${fmtDate(c.dueAt)}`}</li>)}
              {data.signatures.map((s) => <li key={s.id}>{s.title}</li>)}
            </ul>
          </Card>
        )}
        {data.deadlines.length > 0 && (
          <Card title="Upcoming deadlines">
            <ul className="space-y-1 text-sm">{data.deadlines.map((d) => <li key={d.id}><strong>{fmtDate(d.dueAt)}</strong> — {d.title}</li>)}</ul>
          </Card>
        )}
      </div>
    </div>
  );
}
