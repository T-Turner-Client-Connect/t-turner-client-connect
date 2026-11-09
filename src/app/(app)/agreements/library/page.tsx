import Link from "next/link";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { AttorneyNote } from "@/components/agreements/bits";
import { Badge, Button, Card, PageHeader } from "@/components/ui";
import { approveClauseAction, saveClauseAction, saveTemplateAction } from "@/app/actions/agreements";
import { requireUser } from "@/lib/auth/session";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { attorneyNoteDismissed, library, templates } from "@/lib/services/agreements";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Clauses & templates" };

/** The clause library and templates. Tabitha edits and approves; every edit is a new version. */
export default async function AgreementLibraryPage() {
  await connection();
  const user = await requireUser();
  const [lib, tpls, owner, dismissed] = await Promise.all([library(), templates(), isReportApprover(user), attorneyNoteDismissed(user)]);
  const drafts = lib.filter((c) => c.status !== "APPROVED").length;
  return (
    <>
      <PageHeader
        title="Clauses & templates"
        subtitle={owner ? "Edit, approve and version the wording. Agreements already sent keep the exact text they were sent with." : "Only Tabitha edits and approves clauses and templates."}
        actions={<Link className="text-sm underline" href="/agreements">← All agreements</Link>}
      />
      {owner && !dismissed && <div className="mb-4"><AttorneyNote /></div>}
      <p className="mb-4 text-sm text-slate-700" data-testid="library-summary">{lib.length - drafts} approved · {drafts} DRAFT — needs Tabitha&apos;s approval. Clauses from the Jotform Client Service &amp; Payment Agreement are approved as written; placeholders like {"{{TOTAL}}"} are filled from each agreement&apos;s options.</p>

      <Card title="Clauses">
        <ul className="divide-y divide-navy-100" data-testid="clause-list">
          {lib.map((c) => (
            <li key={c.key} className="py-3" data-testid="clause" data-key={c.key} data-status={c.status}>
              <p className="flex flex-wrap items-center gap-2">
                <strong className="text-navy-900">{c.title}</strong>
                <Badge tone={c.kind === "ACK" ? "navy" : "gray"}>{c.kind === "ACK" ? "Acknowledgment (client ticks)" : "Terms"}</Badge>
                {c.status === "APPROVED" ? <Badge tone="green">Approved v{c.version}</Badge> : <Badge tone="amber">DRAFT — needs Tabitha&apos;s approval (v{c.version})</Badge>}
                <span className="text-xs text-slate-600">{c.source === "JOTFORM" ? "From your Jotform, verbatim" : c.source === "EDITED" ? "Edited" : "Drafted for you"}{c.approvedAt ? ` · approved ${fmtDate(c.approvedAt)}` : ""}</span>
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-900">{c.body}</p>
              {owner && (
                <div className="mt-2 flex flex-wrap items-start gap-2">
                  {c.status !== "APPROVED" && <ActionForm action={approveClauseAction.bind(null, c.key)}><Button type="submit" variant="gold" data-testid="approve-clause">Approve as written</Button></ActionForm>}
                  <details className="w-full text-sm">
                    <summary className="cursor-pointer underline">Edit wording (new version)</summary>
                    <ActionForm action={saveClauseAction.bind(null, c.key)} className="mt-2 space-y-2">
                      <textarea className="input" name="body" rows={4} defaultValue={c.body} aria-label={`${c.title} wording`} />
                      <div className="flex gap-2"><Button type="submit" name="intent" value="approve">Save and approve</Button><Button type="submit" name="intent" value="draft" variant="secondary">Save as draft</Button></div>
                    </ActionForm>
                  </details>
                </div>
              )}
              {c.history.length > 1 && <p className="mt-1 text-xs text-slate-500">Versions: {c.history.map((h) => `v${h.version} ${h.status.toLowerCase()} ${fmtDate(h.createdAt)}`).join(" · ")}</p>}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mt-4" title="Templates">
        <ul className="divide-y divide-navy-100">
          {tpls.map((t) => (
            <li key={t.key} className="py-3">
              <p><strong className="text-navy-900">{t.name}</strong> <span className="text-xs text-slate-600">v{t.version} · {t.title}</span></p>
              <p className="text-sm text-slate-700">{t.description}</p>
              <p className="text-xs text-slate-600">Built-in clauses: {t.clauseKeys.map((k) => lib.find((c) => c.key === k)?.title ?? k).join(", ") || "none (picked per agreement)"}. Toggles and options add the rest.</p>
              {owner && (
                <details className="mt-1 text-sm">
                  <summary className="cursor-pointer underline">Edit template (new version)</summary>
                  <ActionForm action={saveTemplateAction.bind(null, t.key)} className="mt-2 space-y-2">
                    <input className="input" name="title" defaultValue={t.title} aria-label="Title" />
                    <textarea className="input" name="intro" rows={2} defaultValue={t.intro} aria-label="Opening line" />
                    <div className="grid gap-x-4 sm:grid-cols-2">{lib.map((c) => <label key={c.key} className="flex min-h-11 items-center gap-2"><input type="checkbox" name="clauseKey" value={c.key} defaultChecked={t.clauseKeys.includes(c.key)} className="size-5 accent-navy-900" /> {c.title}</label>)}</div>
                    <Button type="submit">Save template</Button>
                  </ActionForm>
                </details>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
