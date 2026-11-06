import Link from "next/link";
import { Archive, Briefcase, ChevronDown, CloudUpload, FileBadge, FileText, FolderOpen, IdCard, Receipt, UserRound, Infinity as InfinityIcon, Info, Layers, Mail, MoreHorizontal, ShieldCheck, Upload, Users, UsersRound } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { CLIENT_DOC_TYPES, ALL_DOC_TYPES } from "@/lib/document-types";
import { CATEGORY_LABELS } from "@/lib/services/documents";
import { ID_ROLES, ID_TYPES, type identityOverview, type IdRole, type IdType } from "@/lib/services/identity";
import type { loadPortalDocuments } from "@/lib/portal/views";
import { formatBytes } from "@/lib/files";
import { fmtDate } from "@/lib/format";

type Docs = Awaited<ReturnType<typeof loadPortalDocuments>>;
type Doc = Docs[number];
type Overview = Awaited<ReturnType<typeof identityOverview>>;

export const VAULT_CATEGORIES = [
  { key: "all", label: "All Documents", note: null, icon: Layers },
  { key: "tax", label: "Tax Documents", note: null, icon: FileText },
  { key: "identity", label: "Identity Documents", note: "(ID, Social Security, Birth Certificate)", icon: IdCard },
  { key: "spouse", label: "Spouse Documents", note: null, icon: UsersRound },
  { key: "dependent", label: "Dependent Documents", note: "(Children)", icon: Users },
  { key: "notices", label: "IRS & State Notices", note: null, icon: Mail },
  { key: "archived", label: "Archived Documents", note: null, icon: Archive },
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
          category: archived ? "Archived" : person.role === "SPOUSE" ? "Spouse Document" : person.role === "DEPENDENT" ? "Dependent Document" : "Identity Document",
          year: "—",
          added: r.createdAt,
          status: archived ? "Replaced" : r.status === "VERIFIED" ? "Verified" : r.status === "EXPIRED" ? "Expired" : "Pending verification",
        });
      }
    }
  }
  return rows;
}

const BUCKET_LABEL: Record<string, string> = { notices: "IRS & State Notice", tax: "Tax Document", identity: "Identity Document", dependent: "Dependent Document" };

const docRow = (d: Doc): Row => ({
  kind: "doc",
  id: d.id,
  name: d.title,
  sub: `${d.docType ? `${ALL_DOC_TYPES[d.docType] ?? d.docType} · ` : ""}${formatBytes(d.file.sizeBytes)}`,
  category: BUCKET_LABEL[bucketOf(d) ?? ""] ?? CATEGORY_LABELS[d.category],
  year: d.year ? String(d.year) : "—",
  added: d.publishedAt ?? d.createdAt,
  doc: d,
});

/**
 * A business-only account's vault, in the owner's categories. Presentation only — the same
 * documents, categories and access rules (portalDocumentScope) as before:
 * - Business Tax Documents: TAXES and released BOOKKEEPING documents, and IRS/state notices.
 * - Personal Tax Documents: OWNER_PERSONAL — the signed-in owner's own (never another owner's).
 * - Payroll Documents: PAYROLL (or docType PAYROLL_REPORT); shown when payroll applies to this login.
 * - K-1 Documents: OWNER_K1 (the existing K-1 rules) and K-1s the business received (docType FORM_K1).
 * - Other Supporting Documents: everything else (CLIENT_UPLOADS, OTHER, CONTRACTS).
 */
export const BUSINESS_VAULT_CATEGORIES = [
  { key: "all", label: "All Documents", note: null, icon: Layers },
  { key: "business-tax", label: "Business Tax Documents", note: null, icon: Briefcase },
  { key: "personal-tax", label: "Personal Tax Documents", note: "(only you and our office)", icon: UserRound },
  { key: "payroll", label: "Payroll Documents", note: null, icon: Receipt },
  { key: "k1", label: "K-1 Documents", note: null, icon: FileBadge },
  { key: "other", label: "Other Supporting Documents", note: null, icon: FolderOpen },
] as const;
export type BusinessVaultCat = (typeof BUSINESS_VAULT_CATEGORIES)[number]["key"];
export const isBusinessVaultCat = (v: string | undefined): v is BusinessVaultCat => BUSINESS_VAULT_CATEGORIES.some((c) => c.key === v);

export function businessBucketOf(d: Pick<Doc, "category" | "docType" | "filingDocType">): Exclude<BusinessVaultCat, "all"> {
  if (d.category === "OWNER_PERSONAL") return "personal-tax";
  if (d.category === "OWNER_K1" || d.docType === "FORM_K1") return "k1";
  if (d.category === "PAYROLL" || d.docType === "PAYROLL_REPORT") return "payroll";
  if (d.category === "TAXES" || d.category === "BOOKKEEPING" || NOTICE_TYPES.has(d.docType ?? "") || d.filingDocType === "AGENCY_NOTICE" || d.filingDocType === "CORRESPONDENCE") return "business-tax";
  return "other";
}

const BIZ_LABEL = Object.fromEntries(BUSINESS_VAULT_CATEGORIES.map((c) => [c.key, c.label.replace(/ Documents$/, " Document")]));

export function businessVaultData(docs: Docs) {
  const row = (d: Doc): Row => ({ ...docRow(d), category: BIZ_LABEL[businessBucketOf(d)] });
  const by = (k: Exclude<BusinessVaultCat, "all">) => docs.filter((d) => businessBucketOf(d) === k).map(row);
  return { all: docs.map(row), "business-tax": by("business-tax"), "personal-tax": by("personal-tax"), payroll: by("payroll"), k1: by("k1"), other: by("other") } satisfies Record<BusinessVaultCat, Row[]>;
}

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
  { icon: ShieldCheck, title: "Secure & Private", text: "Encrypted and protected" },
  { icon: Layers, title: "Year-Round Access", text: "View, download, or print anytime" },
  { icon: Users, title: "All in One Place", text: "Your tax, identity, and account documents" },
  { icon: InfinityIcon, title: "Keep Once", text: "Most documents don’t need to be uploaded each year" },
];

/** Light cream strip of four promises, gold icons, thin gold dividers (approved design). */
export function BenefitStrip() {
  return (
    <section className="grid grid-cols-1 gap-y-3 rounded-2xl border border-gold-200 bg-gradient-to-b from-white to-ivory-50 px-4 py-4 shadow-[0_10px_24px_-20px_rgb(10_26_68/0.45)] sm:grid-cols-2 xl:grid-cols-4" data-testid="vault-benefits">
      {BENEFITS.map((b, i) => (
        <div key={b.title} className={`flex items-center gap-3 px-3 ${i > 0 ? "xl:border-l xl:border-gold-300" : ""} ${i % 2 === 1 ? "sm:border-l sm:border-gold-300" : ""}`}>
          <b.icon className="size-10 shrink-0 text-gold-600" strokeWidth={1.5} aria-hidden />
          <span className="min-w-0">
            <span className="block font-serif text-lg font-bold leading-tight text-navy-900">{b.title}</span>
            <span className="block text-sm text-navy-800">{b.text}</span>
          </span>
        </div>
      ))}
    </section>
  );
}

/** Navy-headed card with a title only (Document Categories, Upload a Document). */
function HeadCard({ icon: Icon, title, children, testId }: { icon?: React.ComponentType<{ className?: string }>; title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-ivory-200 bg-white shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)]" data-testid={testId}>
      <h2 className="flex items-center gap-3 bg-navy-900 px-5 py-3.5 font-serif text-xl font-bold text-white">
        {Icon && <Icon className="size-6 shrink-0" aria-hidden />}
        {title}
      </h2>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function CategorySidebar<K extends string = VaultCat>({ active, href, categories = VAULT_CATEGORIES as unknown as readonly { key: K; label: string; note: string | null; icon: React.ComponentType<{ className?: string }> }[] }: { active: K; href: (c: K) => string; categories?: readonly { key: K; label: string; note: string | null; icon: React.ComponentType<{ className?: string }> }[] }) {
  return (
    <HeadCard title="Document Categories">
      <nav aria-label="Document categories" data-testid="vault-categories">
        {categories.map((c) => (
          <Link
            key={c.key}
            href={href(c.key)}
            aria-current={active === c.key ? "page" : undefined}
            className={`flex items-center gap-3 px-3 py-3 text-[15px] text-navy-900 ${active === c.key ? "rounded-xl border border-gold-300 bg-gold-50 font-bold" : "border-b border-ivory-200 last:border-b-0 hover:bg-gold-50/60"}`}
          >
            <c.icon className="size-6 shrink-0 text-gold-600" aria-hidden />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block font-semibold">{c.label}</span>
              {c.note && <span className="block text-xs text-slate-600">{c.note}</span>}
            </span>
          </Link>
        ))}
      </nav>
    </HeadCard>
  );
}

/** "All Years ▾" — a plain list of year links, no script needed. */
function YearFilter({ years, current, href }: { years: { year: number | null; count: number }[]; current: number | "none" | null; href: (y: string | null) => string }) {
  const label = current === null ? "All Years" : current === "none" ? "No tax year" : String(current);
  return (
    <details className="relative" data-testid="vault-years">
      <summary className="flex cursor-pointer list-none items-center gap-6 rounded-lg border border-ivory-300 bg-white px-4 py-2 text-sm font-semibold text-navy-900 shadow-sm [&::-webkit-details-marker]:hidden">
        {label} <ChevronDown className="size-4" aria-hidden />
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-48 rounded-xl border border-ivory-200 bg-white p-1.5 text-sm shadow-xl">
        <Link href={href(null)} className="block rounded-lg px-3 py-1.5 text-navy-900 hover:bg-gold-100">All Years</Link>
        {years.map((f) => (
          <Link key={f.year ?? "none"} href={href(f.year ? String(f.year) : "none")} className="flex justify-between rounded-lg px-3 py-1.5 text-navy-900 hover:bg-gold-100">
            {f.year ?? "No tax year"} <span className="text-slate-500">{f.count}</span>
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

/** Small red "PDF" document mark used on every file row (approved design). */
function PdfIcon() {
  return (
    <span className="relative flex h-7 w-6 shrink-0 items-end justify-center rounded-[3px] border-2 border-red-700 bg-white pb-0.5" aria-hidden>
      <span className="text-[7px] font-black leading-none text-red-700">PDF</span>
    </span>
  );
}

export function DocumentsTable({ rows, years, year, yearHref, linkFor, identityHref }: { rows: Row[]; years: { year: number | null; count: number }[]; year: number | "none" | null; yearHref: (y: string | null) => string; linkFor: (id: string) => string; identityHref: string }) {
  return (
    <section className="min-w-0 rounded-2xl border border-ivory-200 bg-white p-4 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)] sm:p-5" data-testid="vault-table">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Layers className="size-10 shrink-0 text-gold-600" strokeWidth={1.5} aria-hidden />
          <div>
            <h2 className="font-serif text-xl sm:text-xl font-bold leading-tight text-navy-900">All Documents</h2>
            <p className="text-sm text-navy-800">A complete list of your uploaded documents.</p>
          </div>
        </div>
        <YearFilter years={years} current={year} href={yearHref} />
      </div>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-ivory-200 px-5 py-10 text-center text-slate-600">No documents here yet.</p>
      ) : (
        <div className="relative overflow-x-auto rounded-xl border border-ivory-200">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="bg-navy-900 text-left text-white">
                <th className="px-4 py-3 font-semibold">Document Name</th>
                <th className="px-3 py-3 font-semibold">Category</th>
                <th className="px-3 py-3 font-semibold">Tax Year</th>
                <th className="px-3 py-3 font-semibold">Date Uploaded</th>
                <th className="px-3 py-3 text-right font-semibold"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ivory-200">
              {rows.map((r) => (
                <tr key={`${r.kind}-${r.id}`} data-row-kind={r.kind}>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-3">
                      <PdfIcon />
                      <span className="min-w-0">
                        <span className="block text-navy-900 [overflow-wrap:anywhere]">{r.name}</span>
                        {r.kind === "id" && <span className="block text-xs text-slate-600">{r.status}</span>}
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-3 text-navy-800">{r.category}</td>
                  <td className="px-3 py-3 text-navy-800">{r.year}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-navy-800">{fmtDate(r.added)}</td>
                  <td className="px-3 py-3 text-right"><RowActions row={r} linkFor={linkFor} identityHref={identityHref} /></td>
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

export function UploadPanel({ action, defaultYear }: { action: (prev: State, fd: FormData) => Promise<State>; defaultYear: string }) {
  const thisYear = new Date().getFullYear();
  return (
    <HeadCard icon={CloudUpload} title="Upload a Document" testId="vault-upload">
      <ActionForm action={action} className="space-y-3" resetOnSuccess>
        <label className="block">
          <span className="mb-1 block text-sm font-semibold text-navy-900">Document Category</span>
          <select className="input h-10" name="docType" required defaultValue="">
            <option value="" disabled>Choose a category…</option>
            {Object.entries(CLIENT_DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-semibold text-navy-900">Tax Year (if applicable)</span>
          <select className="input h-10" name="year" required defaultValue={defaultYear}>
            <option value="" disabled>Choose year…</option>
            {Array.from({ length: 8 }, (_, i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}
            <option value="unsure">Not sure</option>
          </select>
        </label>
        <label className="relative flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-ivory-300 bg-white px-3 py-5 text-center hover:border-gold-400">
          <CloudUpload className="size-10 text-navy-900" strokeWidth={1.5} aria-hidden />
          <span className="font-semibold text-navy-900">Drag &amp; drop your file here</span>
          <span className="text-sm text-slate-600">or</span>
          <span className="inline-flex items-center gap-2 rounded-full border border-gold-500 bg-gradient-to-b from-gold-100 to-gold-300 px-5 py-1.5 font-semibold text-navy-950 shadow-sm">
            <FolderOpen className="size-4" aria-hidden /> Choose File
          </span>
          <span className="text-xs text-slate-600">Accepted: PDF, JPG, or PNG (max 5 MB)</span>
          <input className="absolute inset-0 cursor-pointer opacity-0" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required aria-label="Choose a file" />
        </label>
        <button type="submit" className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-navy-900 px-6 py-2.5 font-semibold text-white shadow hover:bg-navy-950">
          <Upload className="size-4" aria-hidden /> Upload Document
        </button>
      </ActionForm>
    </HeadCard>
  );
}

export function VaultReminders() {
  return (
    <section className="rounded-2xl border border-ivory-200 bg-white p-4 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)]" data-testid="vault-reminders">
      <h2 className="mb-2 flex items-center gap-2 font-serif text-lg font-bold text-navy-900"><Info className="size-5 text-gold-600" aria-hidden />Helpful Reminders</h2>
      <ul className="list-disc space-y-1 pl-5 text-sm text-navy-800">
        <li>Upload each document once and keep it on file.</li>
        <li>Only update a driver&apos;s license when it expires.</li>
        <li>Most other documents are kept permanently.</li>
      </ul>
    </section>
  );
}
