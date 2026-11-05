"use client";

import { useRef, useState } from "react";
import { CheckCircle2, CloudUpload, FileText, Lock, Trash2 } from "lucide-react";

type Result = { name: string; ok: boolean; message: string; tone: "green" | "amber" | "red" };

const SCAN_TEXT: Record<string, { tone: Result["tone"]; text: string }> = {
  CLEAN: { tone: "green", text: "Saved and passed the virus scan." },
  PENDING: { tone: "amber", text: "Saved. It's being checked for viruses — our team can open it once the check passes." },
  NOT_SCANNED: { tone: "amber", text: "Saved and held securely until our virus check runs — our team can open it once it passes." },
};

/**
 * What to upload, from Tabitha's list (no ID line — identity documents live on their own page).
 * Each item is stored under an existing client document type, with its name as the file's title.
 */
export const UPLOAD_CHECKLIST: { key: string; label: string; note?: string; docType: string }[] = [
  { key: "w2", label: "W-2", note: "Wages from an employer", docType: "W2" },
  { key: "k1", label: "K-1", note: "Partnership, S corporation, estate or trust income", docType: "K1" },
  { key: "charity", label: "Charity donations", note: "Receipts or letters for cash or items you gave", docType: "CLIENT_OTHER" },
  { key: "car-tag", label: "Car tag", note: "Vehicle registration (tag) receipt", docType: "CLIENT_OTHER" },
  { key: "medical", label: "Medical expenses", note: "Doctor, dental, prescription and insurance costs", docType: "CLIENT_OTHER" },
  { key: "1098", label: "1098 – Mortgage interest", docType: "FORM_1098" },
  { key: "1099-nec", label: "1099-NEC", note: "Contract or self-employment income", docType: "FORM_1099" },
  { key: "1099-misc", label: "1099-MISC", note: "Rents, royalties and other income", docType: "FORM_1099" },
  { key: "1099-r", label: "1099-R", note: "Retirement, pension or IRA distributions", docType: "FORM_1099" },
  { key: "1099-int", label: "1099-INT", note: "Bank or savings interest", docType: "FORM_1099" },
  { key: "1099-div", label: "1099-DIV", note: "Dividends from investments", docType: "FORM_1099" },
  { key: "car-interest", label: "Car loan interest", note: "Only for a new vehicle purchased during this tax year", docType: "CLIENT_OTHER" },
  { key: "other", label: "Other / etc.", note: "Anything else for your return", docType: "CLIENT_OTHER" },
];

/**
 * A business owner's own personal supporting documents, sent on a business-only account: the same
 * list plus property taxes. Each is filed privately to that owner and tax year.
 */
export const OWNER_UPLOAD_CHECKLIST: typeof UPLOAD_CHECKLIST = [
  ...UPLOAD_CHECKLIST.filter((i) => i.key !== "other"),
  { key: "property-tax", label: "Property taxes", note: "Real estate or personal property tax bills or receipts", docType: "CLIENT_OTHER" },
  ...UPLOAD_CHECKLIST.filter((i) => i.key === "other"),
];

type Picked = { id: number; file: File; item: string };

/**
 * Upload to the selected tax year with real progress (one request per file), in the approved
 * Upload Documents layout: checklist, "Selected for Upload" panel, drag & drop, Choose Files.
 * Uses the same /api/client/upload endpoint, validation, size limit and virus scan as before.
 */
export function TaxUploadForm({ account, years, defaultYear, vaultHref, owner = false }: { account: string; years: number[]; defaultYear: string; vaultHref: string; owner?: boolean }) {
  // `owner`: a business owner's personal documents on a business-only account (always for a tax year).
  const CHECKLIST = owner ? OWNER_UPLOAD_CHECKLIST : UPLOAD_CHECKLIST;
  const [year, setYear] = useState(defaultYear);
  const [checked, setChecked] = useState<string[]>([]);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ file: string; pct: number } | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);

  function addFiles(list: FileList | null) {
    if (!list?.length) return;
    const first = checked[0] ?? "";
    setPicked((p) => [...p, ...Array.from(list).map((file) => ({ id: nextId.current++, file, item: first }))]);
    setResults([]);
    if (inputRef.current) inputRef.current.value = "";
  }

  function send(f: Picked) {
    const item = CHECKLIST.find((i) => i.key === f.item)!;
    return new Promise<Result>((resolve) => {
      const fd = new FormData();
      fd.set("account", account);
      fd.set("year", year);
      fd.set("docType", item.docType);
      fd.set("title", item.label);
      fd.set("file", f.file);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/client/upload");
      xhr.upload.onprogress = (e) => e.lengthComputable && setProgress({ file: f.file.name, pct: Math.round((e.loaded / e.total) * 100) });
      xhr.onload = () => {
        let body: { ok?: boolean; error?: string; scanStatus?: string } = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status === 200 && body.ok) {
          const s = SCAN_TEXT[body.scanStatus ?? "PENDING"] ?? SCAN_TEXT.PENDING;
          resolve({ name: f.file.name, ok: true, tone: s.tone, message: s.text });
        } else resolve({ name: f.file.name, ok: false, tone: "red", message: body.error ?? `Upload failed (error ${xhr.status}). Nothing was saved.` });
      };
      xhr.onerror = () => resolve({ name: f.file.name, ok: false, tone: "red", message: "Couldn't reach our server — check your connection and try again. Nothing was saved." });
      xhr.send(fd);
    });
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!year) return setError("Choose the tax year, or “Not sure”.");
    if (!picked.length) return setError("Choose at least one file (PDF, photo or scan).");
    if (picked.some((p) => !p.item)) return setError("Choose what each file is in “Selected for Upload”.");
    setBusy(true);
    const out: Result[] = [];
    const failed: Picked[] = [];
    for (const f of picked) {
      const r = await send(f);
      out.push(r);
      if (!r.ok) failed.push(f);
    }
    setResults(out);
    setProgress(null);
    setBusy(false);
    setPicked(failed);
  }

  const toggle = (key: string) => setChecked((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]));
  const options = checked.length ? CHECKLIST.filter((i) => checked.includes(i.key)) : CHECKLIST;

  return (
    <form onSubmit={onSubmit} className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]" data-testid="tax-upload-form" noValidate>
      <div className="min-w-0 space-y-5">
        <label className="block max-w-xs">
          <span className="mb-1.5 block font-semibold text-navy-900">Tax Year <span className="text-red-700">*</span></span>
          <select className="input h-12" name="year" value={year} onChange={(e) => setYear(e.target.value)}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
            {!owner && <option value="unsure">Not sure</option>}
          </select>
        </label>

        <fieldset className="rounded-2xl border border-gold-200 bg-white p-4 sm:p-5" data-testid="upload-checklist">
          <legend className="px-1 font-serif text-xl font-bold text-navy-900">What are you uploading?</legend>
          <p className="mb-3 text-sm text-slate-600">Check everything you have for this tax year.</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {CHECKLIST.map((i) => (
              <li key={i.key}>
                <label className={`flex h-full cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 ${checked.includes(i.key) ? "border-gold-500 bg-gold-50 ring-1 ring-gold-400" : "border-ivory-200 hover:border-gold-300"}`}>
                  <input type="checkbox" checked={checked.includes(i.key)} onChange={() => toggle(i.key)} className="mt-1 size-5 shrink-0 accent-gold-600" data-item={i.key} />
                  <span className="min-w-0">
                    <span className="block font-semibold text-navy-900">{i.label}</span>
                    {i.note && <span className="block text-xs text-slate-600">{i.note}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      </div>

      <div className="min-w-0 space-y-5">
        <section className="overflow-hidden rounded-2xl bg-gradient-to-b from-navy-900 to-navy-950 text-white shadow-[0_14px_32px_-20px_rgb(10_26_68/0.7)] ring-1 ring-gold-500/40" data-testid="selected-for-upload">
          <h2 className="flex items-center gap-2 border-b border-gold-500/40 px-5 py-3.5 font-serif text-xl font-bold text-white">
            <CheckCircle2 className="size-6 text-gold-400" aria-hidden /> Selected for Upload ({picked.length})
          </h2>
          {picked.length === 0 ? (
            <p className="px-5 py-5 text-sm text-navy-100">No files selected yet.</p>
          ) : (
            <ul className="divide-y divide-white/10">
              {picked.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 px-5 py-3">
                  <FileText className="size-5 shrink-0 text-gold-400" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={p.file.name}>{p.file.name}</span>
                  <select aria-label={`What is ${p.file.name}?`} className="w-full rounded-lg border border-white/20 bg-white px-2 py-1.5 text-sm text-navy-900 sm:w-48" value={p.item} onChange={(e) => setPicked((all) => all.map((x) => (x.id === p.id ? { ...x, item: e.target.value } : x)))}>
                    <option value="">What is this?</option>
                    {options.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
                  </select>
                  <button type="button" onClick={() => setPicked((all) => all.filter((x) => x.id !== p.id))} className="rounded-lg p-1.5 text-navy-100 hover:bg-white/10 hover:text-white" aria-label={`Remove ${p.file.name}`}>
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
          className={`flex flex-col items-center rounded-2xl border-2 border-dashed px-4 py-7 text-center ${drag ? "border-gold-500 bg-gold-50" : "border-gold-300 bg-ivory-50/60"}`}
          data-testid="drop-zone"
        >
          <CloudUpload className="size-12 text-gold-600" aria-hidden />
          <p className="mt-2 font-serif text-lg font-bold text-navy-900">Drag &amp; drop files here</p>
          <p className="text-sm text-slate-600">or</p>
          <button type="button" onClick={() => inputRef.current?.click()} className="mt-2 rounded-xl border-2 border-gold-500 bg-white px-6 py-2 font-semibold text-navy-900 hover:bg-gold-50">Choose Files</button>
          <input ref={inputRef} className="sr-only" type="file" multiple accept="application/pdf,image/*" onChange={(e) => addFiles(e.target.files)} data-testid="upload-files" />
          <p className="mt-3 text-xs text-slate-600">PDF, photo or scan, up to 5 MB each. On a phone you can take a photo.</p>
        </div>

        {progress && (
          <div aria-live="polite" data-testid="upload-progress">
            <p className="text-sm">Uploading {progress.file}… {progress.pct}%</p>
            <div className="h-2 overflow-hidden rounded-full bg-ivory-200"><div className="h-full bg-gold-500 transition-all" style={{ width: `${progress.pct}%` }} /></div>
          </div>
        )}
        {error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-800">{error}</p>}
        <button type="submit" disabled={busy} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-navy-900 to-navy-950 px-4 py-3.5 text-lg font-semibold text-white shadow hover:to-navy-900 disabled:opacity-60" data-testid="upload-submit">
          <Lock className="size-5 text-gold-400" aria-hidden /> {busy ? "Uploading…" : "Upload Selected Documents"}
        </button>
        {results.length > 0 && (
          <ul className="space-y-2" aria-live="polite" data-testid="upload-results">
            {results.map((r, i) => (
              <li key={i} className={`rounded-lg px-3 py-2 text-sm ${r.tone === "green" ? "bg-emerald-50 text-emerald-900" : r.tone === "amber" ? "bg-amber-50 text-amber-900" : "bg-red-50 text-red-900"}`}>
                <strong className="[overflow-wrap:anywhere]">{r.name}</strong> — {r.message}
              </li>
            ))}
            {results.some((r) => r.ok) && <li className="text-sm"><a className="font-semibold underline" href={vaultHref}>See it in your Document Vault</a></li>}
          </ul>
        )}
      </div>
    </form>
  );
}
