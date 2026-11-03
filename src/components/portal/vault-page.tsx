import Link from "next/link";
import { Archive, CalendarDays, ChevronDown, CloudUpload, FileText, FolderOpen, IdCard, Landmark, Layers, Lightbulb, Lock, MoreHorizontal, Repeat, Baby, UserRound } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { CLIENT_DOC_TYPES, ALL_DOC_TYPES } from "@/lib/document-types";
import { CATEGORY_LABELS } from "@/lib/services/documents";
import { ID_ROLES, ID_TYPES, type identityOverview, type IdRole, type IdType } from "@/lib/services/identity";
import type { loadPortalDocuments } from "@/lib/portal/views";
import { formatBytes } from "@/lib/files";
import { fmtDate } from "@/lib/format";
import { NavyCard } from "./luxury";

type Docs = Awaited<ReturnType<typeof loadPortalDocuments>>;
type Doc = Docs[number];
type Overview = Awaited<ReturnType<typeof identityOverview>>;

export const VAULT_CATEGORIES = [
  { key: "all", label: "All Documents", icon: Layers },
  { key: "tax", label: "Tax Documents", icon: FileText },
  { key: "identity", label: "Identity Documents", icon: IdCard },
  { key: "spouse", label: "Spouse Documents", icon: UserRound },
  { key: "dependent", label: "Dependent Documents", icon: Baby },
  { key: "notices", label: "IRS & State Notices", icon: Landmark },
  { key: "archived", label: "Archived", icon: Archive },
] as const;
export type VaultCat = (typeof VAULT_CATEGORIES)[number]["key"];
export const isVaultCat = (v: string | undefined): v is VaultCat => VAULT_CATEGORIES.some((c) => c.key === v);

const NOTICE_TYPES = new Set(["AGENCY_NOTICE", "AGENCY_LETTER"]);
const isNotice = (d: Doc) => NOTICE_TYPES.has(d.docType ?? "") || d.filingDocType === "AGENCY_NOTICE" || d.filingDocType === "CORRESPONDENCE";

/** Which vault category a document belongs to (bookkeeping and contracts appear under All only). */
function bucketOf(d: Doc): VaultCat | null {
  if (isNotice(d)) return "notices";
  if (d.docType === "ID_DOCUMENT") return "identity";
  if (d.docType === "CHILDCARE_DEPENDENT") return "dependent";
  if (d.category === "TAXES" || d.category === "CLIENT_UPLOADS" || d.category === "OTHER") return "tax";
  return null;
}

/** A row in the table: a vault file, or an identity record (status only — opened from Identity Documents). */
type Row =
  | { kind: "doc"; id: string; name: string; sub: string; category: string; year: string; added: Date; doc: Doc }
  | { kind: "id"; id: string; name: string; sub: string; category: string; year: string; added: Date; status: string };

function identityRows(overview: Overview, filter: (role: string) => boolean, archived: boolean): Row[] {
  const rows: Row[] = [];
  for (const { person, slots } of overview) {
    if (!filter(person.role)) continue;
    for (const s of slots) {
      const recs = archived ? s.history.filter((h) => h.status === "REPLACED") : [s.current, ...s.pending].filter((r): r is NonNullable<typeof r> => !!r);
      for (const r of recs) {
        rows.push({
          kind: "id",
          id: r.id,
          name: `${ID_TYPES[s.type as IdType].label} — ${person.name}`,
          sub: `${ID_ROLES[person.role as IdRole]}${archived ? " · previous version" : ""}`,
          category: archived ? "Archived" : person.role === "SPOUSE" ? "Spouse" : person.role === "DEPENDENT" ? "Dependent" : "Identity",
          year: "Permanent",
          added: r.createdAt,
          status: archived ? "Replaced" : r.status === "VERIFIED" ? "Verified" : r.status === "EXPIRED" ? "Expired" : "Pending verification",
        });
      }
    }
  }
  return rows;
}

const docRow = (d: Doc): Row => ({
  kind: "doc",
  id: d.id,
  name: d.title,
  sub: `${d.docType ? `${ALL_DOC_TYPES[d.docType] ?? d.docType} · ` : ""}${formatBytes(d.file.sizeBytes)}`,
  category: bucketOf(d) === "notices" ? "IRS & State Notice" : CATEGORY_LABELS[d.category],
  year: d.year ? String(d.year) : "Year to confirm",
  added: d.publishedAt ?? d.createdAt,
  doc: d,
});

export function vaultData(docs: Docs, overview: Overview | null) {
  const ov = overview ?? [];
  const byCat: Record<VaultCat, Row[]> = {
    all: [...docs.map(docRow), ...identityRows(ov, () => true, false)],
    tax: docs.filter((d) => bucketOf(d) === "tax").map(docRow),
    identity: [...docs.filter((d) => bucketOf(d) === "identity").map(docRow), ...identityRows(ov, (r) => r === "CLIENT", false)],
    spouse: identityRows(ov, (r) => r === "SPOUSE", false),
    dependent: [...docs.filter((d) => bucketOf(d) === "dependent").map(docRow), ...identityRows(ov, (r) => r === "DEPENDENT", false)],
    notices: docs.filter((d) => bucketOf(d) === "notices").map(docRow),
    archived: identityRows(ov, () => true, true),
  };
  return byCat;
}

const BENEFITS = [
  { icon: Lock, title: "Secure & Private", text: "Encrypted, malware-scanned, and private to you and our office." },
  { icon: CalendarDays, title: "Year-Round Access", text: "Open your documents any time, every tax year." },
  { icon: FolderOpen, title: "All in One Place", text: "Tax records, notices and identity documents together." },
  { icon: Repeat, title: "Keep Once", text: "Upload a document once — it stays on file." },
];

export function BenefitStrip() {
  return (
    <section className="grid gap-px overflow-hidden rounded-2xl bg-gold-500/30 ring-1 ring-gold-500/40 sm:grid-cols-2 xl:grid-cols-4" data-testid="vault-benefits">
      {BENEFITS.map((b) => (
        <div key={b.title} className="flex items-center gap-3 bg-gradient-to-br from-navy-900 to-navy-950 px-5 py-4 text-white">
          <b.icon className="size-8 shrink-0 text-gold-400" aria-hidden />
          <span className="min-w-0">
            <span className="block font-serif text-lg font-bold leading-tight text-white">{b.title}</span>
            <span className="block text-sm text-navy-100">{b.text}</span>
          </span>
        </div>
      ))}
    </section>
  );
}

export function CategorySidebar({ data, active, href }: { data: Record<VaultCat, Row[]>; active: VaultCat; href: (c: VaultCat) => string }) {
  return (
    <NavyCard icon={FolderOpen} title="Document Categories">
      <nav aria-label="Document categories" className="-mx-1 space-y-1" data-testid="vault-categories">
        {VAULT_CATEGORIES.map((c) => (
          <Link
            key={c.key}
            href={href(c.key)}
            aria-current={active === c.key ? "page" : undefined}
            className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] ${active === c.key ? "bg-gradient-to-b from-gold-300 to-gold-500 font-bold text-navy-950 ring-1 ring-gold-200" : "text-navy-900 hover:bg-gold-50"}`}
          >
            <c.icon className="size-5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">{c.label}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${active === c.key ? "bg-navy-900 text-gold-300" : "bg-ivory-100 text-navy-900"}`}>{data[c.key].length}</span>
          </Link>
        ))}
      </nav>
    </NavyCard>
  );
}

/** "All Years ▾" — a plain list of year links, no script needed. */
function YearFilter({ years, current, href }: { years: { year: number | null; count: number }[]; current: number | "none" | null; href: (y: string | null) => string }) {
  const label = current === null ? "All Years" : current === "none" ? "Year to confirm" : String(current);
  return (
    <details className="relative" data-testid="vault-years">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-gold-500 bg-white px-4 py-1.5 text-sm font-semibold text-navy-900 [&::-webkit-details-marker]:hidden">
        {label} <ChevronDown className="size-4" aria-hidden />
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-48 rounded-xl border border-ivory-200 bg-white p-1.5 text-sm shadow-xl">
        <Link href={href(null)} className="block rounded-lg px-3 py-1.5 text-navy-900 hover:bg-gold-100">All Years</Link>
        {years.map((f) => (
          <Link key={f.year ?? "none"} href={href(f.year ? String(f.year) : "none")} className="flex justify-between rounded-lg px-3 py-1.5 text-navy-900 hover:bg-gold-100">
            {f.year ?? "Year to confirm"} <span className="text-slate-500">{f.count}</span>
          </Link>
        ))}
      </div>
    </details>
  );
}

function RowActions({ row, linkFor, identityHref }: { row: Row; linkFor: (id: string) => string; identityHref: string }) {
  return (
    <details className="relative inline-block text-left">
      <summary className="flex size-9 cursor-pointer list-none items-center justify-center rounded-full text-navy-900 hover:bg-gold-100 [&::-webkit-details-marker]:hidden" aria-label={`Actions for ${row.name}`}>
        <MoreHorizontal className="size-5" aria-hidden />
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-56 rounded-xl border border-ivory-200 bg-white p-1.5 text-sm shadow-xl">
        {row.kind === "doc" ? (
          <>
            <a className="block rounded-lg px-3 py-2 text-navy-900 hover:bg-gold-100" href={linkFor(row.id)} target="_blank" rel="noopener">View</a>
            <a className="block rounded-lg px-3 py-2 text-navy-900 hover:bg-gold-100" href={`${linkFor(row.id)}?download=1`}>Download</a>
          </>
        ) : (
          <Link className="block rounded-lg px-3 py-2 text-navy-900 hover:bg-gold-100" href={identityHref}>Open in Identity Documents</Link>
        )}
      </div>
    </details>
  );
}

export function DocumentsTable({ rows, title, years, year, yearHref, linkFor, identityHref }: { rows: Row[]; title: string; years: { year: number | null; count: number }[]; year: number | "none" | null; yearHref: (y: string | null) => string; linkFor: (id: string) => string; identityHref: string }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-ivory-200 bg-white shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)]" data-testid="vault-table">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-navy-900 px-5 py-3.5">
        <h2 className="flex items-center gap-3 font-serif text-xl font-bold text-white sm:text-2xl"><FileText className="size-6 shrink-0" aria-hidden />{title}</h2>
        <YearFilter years={years} current={year} href={yearHref} />
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-slate-600">No documents here yet.</p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-ivory-200 text-left text-navy-900">
                <th className="px-5 py-3 font-semibold">Document</th>
                <th className="px-3 py-3 font-semibold">Category</th>
                <th className="px-3 py-3 font-semibold">Tax Year</th>
                <th className="px-3 py-3 font-semibold">Date Added</th>
                <th className="px-5 py-3 text-right font-semibold"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ivory-200">
              {rows.map((r) => (
                <tr key={`${r.kind}-${r.id}`} data-row-kind={r.kind}>
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-3">
                      {r.kind === "doc" ? <FileText className="size-5 shrink-0 text-gold-600" aria-hidden /> : <IdCard className="size-5 shrink-0 text-gold-600" aria-hidden />}
                      <span className="min-w-0">
                        <span className="block font-semibold text-navy-900 [overflow-wrap:anywhere]">{r.name}</span>
                        <span className="block text-xs text-slate-600">{r.kind === "id" ? `${r.sub} · ${r.status}` : r.sub}</span>
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-3 text-navy-800">{r.category}</td>
                  <td className="px-3 py-3 text-navy-800">{r.year}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-navy-800">{fmtDate(r.added)}</td>
                  <td className="px-5 py-3 text-right"><RowActions row={r} linkFor={linkFor} identityHref={identityHref} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type State = { error?: string; ok?: string; at?: number } | null;

export function UploadPanel({ action, accountName, defaultYear, children }: { action: (prev: State, fd: FormData) => Promise<State>; accountName: string; defaultYear: string; children?: React.ReactNode }) {
  const thisYear = new Date().getFullYear();
  return (
    <NavyCard icon={CloudUpload} title="Upload a Document">
      <p className="mb-3 text-sm text-slate-600" data-testid="upload-target">Saving to: <strong className="text-navy-900">{accountName}</strong></p>
      <ActionForm action={action} className="space-y-4" resetOnSuccess>
        <label className="block">
          <span className="mb-1.5 block font-semibold text-navy-900">Category</span>
          <select className="input" name="docType" required defaultValue="">
            <option value="" disabled>Choose…</option>
            {Object.entries(CLIENT_DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block font-semibold text-navy-900">Tax Year</span>
          <select className="input" name="year" required defaultValue={defaultYear}>
            <option value="" disabled>Choose…</option>
            {Array.from({ length: 8 }, (_, i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}
            <option value="unsure">Not sure</option>
          </select>
        </label>
        <label className="relative flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-gold-400 bg-gold-50/40 px-4 py-7 text-center hover:bg-gold-50">
          <CloudUpload className="size-10 text-gold-600" aria-hidden />
          <span className="font-semibold text-navy-900">Drag &amp; drop your file here</span>
          <span className="text-sm text-slate-600">or click to choose · PDF, JPG or PNG up to 5 MB</span>
          <input className="mt-1 w-full max-w-full text-sm" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required />
        </label>
        <button type="submit" className="w-full rounded-xl bg-gradient-to-b from-navy-900 to-navy-950 px-6 py-3 font-semibold text-white shadow hover:to-navy-900">Upload Securely</button>
      </ActionForm>
      {children}
    </NavyCard>
  );
}

export function VaultReminders() {
  return (
    <NavyCard icon={Lightbulb} title="Helpful Reminders">
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] text-navy-800" data-testid="vault-reminders">
        <li>Choose the tax year each document is for — pick &ldquo;Not sure&rdquo; and we&apos;ll sort it.</li>
        <li>New uploads are checked for viruses, then reviewed by our team.</li>
        <li>Social Security cards and birth certificates live in Identity Documents and can&apos;t be opened in the portal.</li>
        <li>Download links expire shortly after the page loads — refresh the page to open a document again.</li>
      </ul>
    </NavyCard>
  );
}
