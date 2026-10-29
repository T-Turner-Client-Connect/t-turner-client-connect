import { FileText } from "lucide-react";
import type { DocumentCategory } from "@prisma/client";
import { Card, EmptyState } from "@/components/ui";
import type { loadPortalDocuments } from "@/lib/portal/views";
import { CATEGORY_LABELS, REPORT_LABELS } from "@/lib/services/documents";
import { MONTHS } from "@/lib/services/bookkeeping";
import { formatBytes } from "@/lib/files";
import { fmtDate } from "@/lib/format";

type Docs = Awaited<ReturnType<typeof loadPortalDocuments>>;

export function PortalDocumentsView({ docs, linkFor }: { docs: Docs; linkFor: (id: string) => string }) {
  if (!docs.length) return <EmptyState title="No documents yet">Documents shared with you will appear here, organized by year and month.</EmptyState>;
  const byCat = new Map<DocumentCategory, Docs>();
  for (const d of docs) byCat.set(d.category, [...(byCat.get(d.category) ?? []), d]);
  return (
    <div className="space-y-4">
      {[...byCat.entries()].map(([cat, items]) => {
        const folders = new Map<string, Docs>();
        for (const d of items) {
          const f = d.year ? `${d.year}${d.month ? ` · ${MONTHS[d.month - 1]}` : ""}` : "Other";
          folders.set(f, [...(folders.get(f) ?? []), d]);
        }
        return (
          <Card key={cat} title={CATEGORY_LABELS[cat]}>
            {[...folders.entries()].map(([folder, list]) => (
              <details key={folder} open className="mb-2">
                <summary className="cursor-pointer font-semibold text-navy-800">📁 {folder}</summary>
                <ul className="mt-1 divide-y divide-navy-100">
                  {list.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="flex items-center gap-2">
                        <FileText className="size-5 text-navy-700" aria-hidden />
                        <span>
                          <a className="font-medium text-navy-900 underline" href={linkFor(d.id)} target="_blank" rel="noopener">{d.title}</a>
                          <span className="block text-xs text-slate-600">{d.reportType ? `${REPORT_LABELS[d.reportType]} · ` : ""}{formatBytes(d.file.sizeBytes)} · {fmtDate(d.publishedAt ?? d.createdAt)}</span>
                        </span>
                      </span>
                      <a className="text-sm font-semibold underline" href={`${linkFor(d.id)}?download=1`}>Download</a>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </Card>
        );
      })}
    </div>
  );
}
