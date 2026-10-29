import { SCAN_LABELS } from "@/lib/scan-labels";
import { TAX_DOC_TYPES } from "@/lib/document-types";
import type { DocumentCategory } from "@prisma/client";
import type { Actor } from "@/lib/auth/actor";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Button, Card, EmptyState, Notice } from "@/components/ui";
import { acknowledgeDocumentsAction, deleteDocumentAction, setVisibilityAction } from "@/app/actions/workspace";
import { UploadDocumentForm } from "@/components/upload-document-form";
import { prisma } from "@/lib/prisma";
import { CATEGORY_LABELS, downloadToken, REPORT_LABELS } from "@/lib/services/documents";
import { MONTHS } from "@/lib/services/bookkeeping";
import { scanConfigured } from "@/lib/scan";
import { formatBytes } from "@/lib/files";
import { fmtDate, fmtDateTime } from "@/lib/format";

const SCAN = SCAN_LABELS;

export async function DocumentsTab({ clientId, user }: { clientId: string; user: Actor }) {
  const docs = await prisma.document.findMany({
    where: { clientId },
    include: {
      file: { select: { originalName: true, sizeBytes: true, mimeType: true } },
      uploadedByStaff: { select: { name: true } },
      uploadedByPortal: { select: { name: true } },
      accessLogs: { orderBy: { createdAt: "desc" }, take: 10, include: { portalUser: { select: { name: true } } } },
    },
    orderBy: [{ year: "desc" }, { month: "desc" }, { createdAt: "desc" }],
  });
  const staffNames = new Map((await prisma.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const live = docs.filter((d) => !d.deletedAt);
  const deleted = docs.filter((d) => d.deletedAt);
  const now = new Date();

  // Category → "Year · Month" folder → documents
  const tree = new Map<DocumentCategory, Map<string, typeof live>>();
  for (const d of live) {
    const folder = d.year ? `${d.year}${d.month ? ` · ${MONTHS[d.month - 1]}` : ""}` : "Undated";
    if (!tree.has(d.category)) tree.set(d.category, new Map());
    const f = tree.get(d.category)!;
    f.set(folder, [...(f.get(folder) ?? []), d]);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        {!scanConfigured() && (
          <Notice tone="warn" title="Malware scanning: setup required">
            New files stay quarantined — no downloads and nothing shown to the client — until a malware scanner is connected and the file passes. See Documents → Malware scanning.
          </Notice>
        )}
        {live.some((d) => d.needsReview) && (
          <Card title={`New from the client — needs review (${live.filter((d) => d.needsReview).length})`}>
            <ul className="divide-y divide-navy-100 text-sm" data-testid="needs-review">
              {live.filter((d) => d.needsReview).map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <strong>{d.title}</strong> · {d.year ?? "year not given"} · {fmtDateTime(d.createdAt)} · <Badge tone={SCAN[d.scanStatus].tone}>{SCAN[d.scanStatus].text}</Badge>
                  </span>
                  <ActionForm action={acknowledgeDocumentsAction.bind(null, clientId, d.id)}><Button variant="ghost">Mark reviewed</Button></ActionForm>
                </li>
              ))}
            </ul>
            <ActionForm action={acknowledgeDocumentsAction.bind(null, clientId, null)} className="mt-2"><Button variant="secondary">Mark all reviewed</Button></ActionForm>
          </Card>
        )}
        {live.length === 0 && <EmptyState title="No documents yet">Upload reports, tax documents or contracts on the right.</EmptyState>}
        {(Object.keys(CATEGORY_LABELS) as DocumentCategory[]).filter((c) => tree.has(c)).map((cat) => (
          <Card key={cat} title={CATEGORY_LABELS[cat]}>
            {[...tree.get(cat)!.entries()].map(([folder, items]) => (
              <details key={folder} open className="mb-3">
                <summary className="cursor-pointer font-semibold text-navy-800">📁 {folder} <span className="font-normal text-slate-500">({items.length})</span></summary>
                <ul className="mt-2 divide-y divide-navy-100">
                  {items.map((d) => {
                    const link = `/api/documents/${downloadToken(d.id, { staffId: user.id })}`;
                    return (
                      <li key={d.id} className="py-2">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            {d.scanStatus === "CLEAN" ? (
                              <a href={link} target="_blank" rel="noopener" className="font-medium text-navy-900 underline">{d.title}</a>
                            ) : (
                              <span className="font-medium text-navy-900">{d.title}</span>
                            )}
                            <p className="text-xs text-slate-600">
                              {d.file.originalName} · {formatBytes(d.file.sizeBytes)} · {d.uploadedByPortal ? `Uploaded by client (${d.uploadedByPortal.name})` : `Uploaded by ${d.uploadedByStaff?.name ?? "staff"}`} · {fmtDate(d.createdAt)}
                              {d.retainUntil && ` · Keep until ${fmtDate(d.retainUntil)}`}
                              {d.retainUntil && d.retainUntil < now && " (retention period ended)"}
                            </p>
                            <div className="mt-1 flex flex-wrap gap-1">
                              <Badge tone={d.visibility === "PUBLISHED" ? "green" : "gray"}>
                                {d.visibility === "PUBLISHED" ? (d.scanStatus === "CLEAN" ? "Visible to client" : "Will show to client after the scan passes") : "Staff only"}
                              </Badge>
                              {d.docType && <Badge tone="navy">{TAX_DOC_TYPES[d.docType as keyof typeof TAX_DOC_TYPES] ?? d.docType}</Badge>}
                              {d.reportType && <Badge tone="navy">{REPORT_LABELS[d.reportType]}</Badge>}
                              <Badge tone={SCAN[d.scanStatus].tone}>{SCAN[d.scanStatus].text}</Badge>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {d.scanStatus === "CLEAN" ? (
                              <a className="rounded-lg px-3 py-2 text-sm font-semibold text-navy-900 hover:bg-navy-100" href={`${link}?download=1`}>Download</a>
                            ) : (
                              <span className="px-3 py-2 text-xs text-slate-600">Download blocked until the scan passes</span>
                            )}
                            {d.visibility === "PUBLISHED" ? (
                              <ConfirmButton action={setVisibilityAction.bind(null, clientId, d.id, "STAFF_ONLY")} variant="ghost">Unpublish</ConfirmButton>
                            ) : (
                              <ConfirmButton action={setVisibilityAction.bind(null, clientId, d.id, "PUBLISHED")} variant="ghost" confirm="Publish this document to the client's portal? They'll get a sign-in notice.">Publish</ConfirmButton>
                            )}
                          </div>
                        </div>
                        <details className="mt-1 text-xs">
                          <summary className="cursor-pointer text-slate-600">Access log{user.role === "ADMIN" ? " & deletion" : ""}</summary>
                          <ul className="mt-1 space-y-0.5 text-slate-600">
                            {d.accessLogs.map((l) => (
                              <li key={l.id}>{l.action.toLowerCase()} · {l.portalUser ? `${l.portalUser.name} (client)` : staffNames.get(l.staffUserId ?? "") ?? "staff"} · {fmtDateTime(l.createdAt)}</li>
                            ))}
                          </ul>
                          {user.role === "ADMIN" && (
                            <ActionForm action={deleteDocumentAction.bind(null, clientId, d.id)} className="mt-2 flex flex-wrap gap-2" confirm="Permanently delete this file? The record of it stays in the audit log.">
                              <input className="input w-64" name="reason" placeholder="Reason for deletion (required)" required />
                              <Button variant="danger" type="submit">Delete file</Button>
                            </ActionForm>
                          )}
                        </details>
                      </li>
                    );
                  })}
                </ul>
              </details>
            ))}
          </Card>
        ))}
        {deleted.length > 0 && (
          <Card title={`Deleted (${deleted.length})`}>
            <ul className="text-sm text-slate-600">
              {deleted.map((d) => <li key={d.id}>{d.title} — deleted {fmtDate(d.deletedAt)}: {d.deletionReason}</li>)}
            </ul>
          </Card>
        )}
      </div>
      <Card title="Upload a document">
        <UploadDocumentForm clientId={clientId} />
      </Card>
    </div>
  );
}
