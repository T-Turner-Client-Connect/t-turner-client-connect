import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { openAuditAction } from "@/app/actions/audit-center";
import { portalViewer } from "@/lib/portal/viewer";
import { PreviewDisabled } from "@/components/portal/preview-off";
import { prisma } from "@/lib/prisma";
import { AUDIT_KINDS, AUDIT_STATUS, portalAudits, type AuditKind, type AuditStatus } from "@/lib/services/audit-center";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Audit" };

const STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ account?: string; kind?: string }> }) {
  const sp = await searchParams;
  const v = await portalViewer("audit", sp.account);
  const { user, current } = v;
  if (!current) return null;
  const q = `?account=${current.clientId}`;
  const audits = user
    ? await portalAudits(user, current.clientId)
    : (await prisma.noticeCase.findMany({ where: { clientId: current.clientId, auditKind: { not: null } }, orderBy: { createdAt: "desc" } })).map((c) => ({ id: c.id, kind: c.auditKind as AuditKind, stateCode: c.stateCode, taxYear: c.taxYear, status: (c.auditStatus ?? "NOTICE_RECEIVED") as AuditStatus, responseDueOn: c.responseDueOn, needed: [], packageReady: !!c.releasedAt }));
  const kind = sp.kind === "STATE" ? "STATE" : sp.kind === "FEDERAL" ? "FEDERAL" : null;
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 10 }, (_, i) => thisYear - 1 - i);
  return (
    <>
      <PageHeader title="Audit" subtitle="If you received an audit letter from the IRS or your state, upload it here. Our office and Coetha prepare an organized response package for you." />
      <div className="grid gap-4 sm:grid-cols-2" data-testid="audit-kinds">
        {(Object.keys(AUDIT_KINDS) as AuditKind[]).map((k) => {
          const mine = audits.filter((a) => a.kind === k);
          return (
            <Card key={k} title={AUDIT_KINDS[k]}>
              <p className="text-sm text-slate-600">{k === "FEDERAL" ? "A letter from the Internal Revenue Service." : "A letter from a state department of revenue."}</p>
              {mine.length > 0 && (
                <ul className="mt-3 divide-y divide-ivory-200 text-sm">
                  {mine.map((a) => (
                    <li key={a.id} className="py-2">
                      <Link className="font-semibold text-navy-900 underline" href={`/client/audit/${a.id}${q}`}>Tax year {a.taxYear}{a.stateCode ? ` · ${a.stateCode}` : ""}</Link>{" "}
                      <Badge tone={a.packageReady ? "green" : a.needed.length ? "amber" : "navy"}>{a.packageReady ? "Package ready to print" : AUDIT_STATUS[a.status]}</Badge>
                      {a.needed.length > 0 && <span className="block text-xs text-amber-800">{a.needed.length} document{a.needed.length === 1 ? "" : "s"} needed from you</span>}
                      {a.responseDueOn && <span className="block text-xs text-slate-600">Response due {fmtDate(a.responseDueOn)}</span>}
                    </li>
                  ))}
                </ul>
              )}
              <Link className="mt-3 inline-block text-sm font-semibold text-navy-900 underline" href={`/client/audit${q}&kind=${k}#upload`}>Upload a {k === "FEDERAL" ? "federal" : "state"} audit notice</Link>
            </Card>
          );
        })}
      </div>

      {kind && (
        <Card title={`Upload your ${AUDIT_KINDS[kind].toLowerCase()} notice`} className="mt-4 max-w-2xl">
          <div id="upload" />
          {!current.canUpload ? (
            <Notice tone="warn" title="Uploading isn't included in your access to this account">Ask the account owner, or <Link className="underline" href={`/client/messages${q}`}>message our office</Link>.</Notice>
          ) : (
            <PreviewDisabled readOnly={v.readOnly}>
              <ActionForm action={v.act(openAuditAction, current.clientId)} className="grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="kind" value={kind} />
                {kind === "STATE" && (
                  <Field label="State">
                    <select className="input" name="stateCode" required defaultValue=""><option value="" disabled>Choose the state</option>{STATES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
                  </Field>
                )}
                <Field label="Tax year on the notice">
                  <select className="input" name="taxYear" required defaultValue=""><option value="" disabled>Choose the year</option>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>
                </Field>
                <Field label="Date you received it (optional)"><input className="input" type="date" name="receivedOn" /></Field>
                <Field label="Response deadline, if the letter gives one"><input className="input" type="date" name="responseDueOn" /></Field>
                <Field label="Message for our office (optional)" className="sm:col-span-2"><textarea className="input" name="message" rows={2} /></Field>
                <Field label="The audit notice: photos of every page, or a PDF" className="sm:col-span-2"><input className="input" type="file" name="file" multiple required accept="application/pdf,image/*" /></Field>
                <div className="sm:col-span-2"><Button type="submit">Send audit notice securely</Button></div>
              </ActionForm>
            </PreviewDisabled>
          )}
          <p className="mt-3 text-xs text-slate-600">Our office is alerted right away. Don&apos;t ignore a deadline while we prepare your package; call us if it&apos;s close.</p>
        </Card>
      )}
    </>
  );
}
