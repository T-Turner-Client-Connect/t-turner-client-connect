import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { intakeSummary } from "@/lib/services/questionnaire-intake";
import { fmtDate } from "@/lib/format";

/** Small status card on the main tax page; the tools live on the Questionnaires page. */
export async function QuestionnaireStatusCard({ clientId, years }: { clientId: string; years: number[] }) {
  const rows = await Promise.all([...years].sort((a, b) => b - a).map(async (y) => ({ year: y, s: await intakeSummary(clientId, y) })));
  return (
    <Card title="Tax Questionnaires & Intake" actions={<Link className="text-sm font-semibold underline" href={`/clients/${clientId}/questionnaires`}>Manage questionnaires →</Link>}>
      <ul className="divide-y divide-ivory-200 text-sm" data-testid="questionnaire-status">
        {rows.map(({ year, s }) => {
          const submitted = s.submissions[0]?.submittedAt ?? s.submissions[0]?.createdAt;
          return (
            <li key={year} className="flex flex-wrap items-center justify-between gap-2 py-2" data-year={year}>
              <span className="font-semibold text-navy-900">{year}</span>
              <span className="flex items-center gap-2">
                <span className="text-xs text-slate-600">
                  {submitted ? `Submitted ${fmtDate(submitted)}` : s.request?.sentAt ? `Sent ${fmtDate(s.request.sentAt)}` : s.request?.openedAt ? `Opened ${fmtDate(s.request.openedAt)}` : ""}
                </span>
                <Badge tone={s.tone}>{s.label}</Badge>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
