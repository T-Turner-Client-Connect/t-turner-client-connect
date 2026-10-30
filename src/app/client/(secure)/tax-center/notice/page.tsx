import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { submitNoticeAction } from "@/app/actions/notices";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { questionnaireYears } from "@/lib/services/tax-center";
import { AGENCIES, clientNoticeCases, NOTICE_STATUS } from "@/lib/services/notices";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Upload Audit or Tax Notice" };

export default async function NoticeUpload({ searchParams }: { searchParams: Promise<{ account?: string; year?: string }> }) {
  const user = await requirePortalUser();
  const sp = await searchParams;
  const { current } = await resolveAccount(user.id, sp.account);
  if (!current) return null;
  const q = `?account=${current.clientId}`;
  const years = questionnaireYears();
  const all = [...years, ...Array.from({ length: 11 }, (_, i) => years[0] - 4 - i)];
  const cases = await clientNoticeCases(user, current.clientId);
  return (
    <>
      <p className="mb-2 text-sm"><Link className="underline" href={`/client/tax-center${q}`}>← My Tax Center</Link></p>
      <PageHeader title="Upload Audit or Tax Notice" subtitle="Got a letter from the IRS, your state or a city? Send it here so we can track it and any response deadline." />
      {!current.canUpload ? (
        <Notice tone="warn" title="Uploading isn't included in your access to this account">Ask the account owner, or <Link className="underline" href={`/client/messages${q}`}>message our office</Link>.</Notice>
      ) : (
        <Card className="max-w-2xl">
          <ActionForm action={submitNoticeAction.bind(null, current.clientId)} className="grid gap-3 sm:grid-cols-2" resetOnSuccess>
            <Field label="Tax year on the notice">
              <select className="input" name="taxYear" defaultValue={sp.year && all.includes(Number(sp.year)) ? sp.year : "unsure"}>
                <option value="unsure">Not sure</option>
                {all.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </Field>
            <Field label="Who sent it?">
              <select className="input" name="agency" defaultValue="NOT_SURE">{Object.entries(AGENCIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </Field>
            <Field label="Which state or city? (optional)"><input className="input" name="agencyDetail" placeholder="e.g. Alabama Dept. of Revenue" /></Field>
            <Field label="Date you received it (optional)"><input className="input" type="date" name="receivedOn" /></Field>
            <Field label="Response deadline, if the letter gives one" hint="Leave blank if you're not sure"><input className="input" type="date" name="responseDueOn" /></Field>
            <Field label="Message for our office (optional)" className="sm:col-span-2"><textarea className="input" name="message" rows={3} /></Field>
            <Field label="The notice — photos of every page, or a PDF (up to 5 MB each)" className="sm:col-span-2"><input className="input" type="file" name="file" multiple accept="application/pdf,image/*" /></Field>
            <div className="sm:col-span-2"><Button type="submit">Send notice securely</Button></div>
          </ActionForm>
          <p className="mt-3 text-xs text-slate-600">We&apos;ll confirm when it&apos;s received. Receiving it doesn&apos;t mean it has been reviewed or answered — we&apos;ll contact you about next steps. Don&apos;t ignore a deadline while you wait; call us if it&apos;s close.</p>
        </Card>
      )}
      {cases.length > 0 && (
        <Card title="Your notices" className="mt-4 max-w-2xl">
          <ul className="divide-y divide-navy-100 text-sm" data-testid="client-notices">
            {cases.map((c) => (
              <li key={c.id} className="py-2">
                <strong>{AGENCIES[c.agency as keyof typeof AGENCIES]}</strong>{c.agencyDetail && ` (${c.agencyDetail})`} · tax year {c.taxYear ?? "not sure"} · sent {fmtDate(c.createdAt)}
                {c.responseDueOn && ` · response deadline you gave: ${fmtDate(c.responseDueOn)}`}{" "}
                <Badge tone={NOTICE_STATUS[c.status as keyof typeof NOTICE_STATUS].tone}>{NOTICE_STATUS[c.status as keyof typeof NOTICE_STATUS].label}</Badge>
                <span className="block text-xs text-slate-600">{c.documents.length} file{c.documents.length === 1 ? "" : "s"} in your Document Vault{c.taxYear ? ` (${c.taxYear})` : ""}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
