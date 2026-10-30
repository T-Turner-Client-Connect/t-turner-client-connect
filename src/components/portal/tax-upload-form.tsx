"use client";

import { useRef, useState } from "react";

type Result = { name: string; ok: boolean; message: string; tone: "green" | "amber" | "red" };

const SCAN_TEXT: Record<string, { tone: Result["tone"]; text: string }> = {
  CLEAN: { tone: "green", text: "Saved and passed the virus scan." },
  PENDING: { tone: "amber", text: "Saved. It's being checked for viruses — our team can open it once the check passes." },
  NOT_SCANNED: { tone: "amber", text: "Saved and held securely until our virus check runs — our team can open it once it passes." },
};

/**
 * Upload to the selected tax year with real progress (one request per file).
 * Phones can pick a photo, take one with the camera, or choose a PDF.
 */
export function TaxUploadForm({ account, years, defaultYear, categories, vaultHref }: { account: string; years: number[]; defaultYear: string; categories: Record<string, string>; vaultHref: string }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ file: string; pct: number } | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function send(file: File, fields: FormData) {
    return new Promise<Result>((resolve) => {
      const fd = new FormData();
      for (const k of ["account", "year", "docType", "title"]) fd.set(k, String(fields.get(k) ?? ""));
      fd.set("file", file);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/client/upload");
      xhr.upload.onprogress = (e) => e.lengthComputable && setProgress({ file: file.name, pct: Math.round((e.loaded / e.total) * 100) });
      xhr.onload = () => {
        let body: { ok?: boolean; error?: string; scanStatus?: string } = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status === 200 && body.ok) {
          const s = SCAN_TEXT[body.scanStatus ?? "PENDING"] ?? SCAN_TEXT.PENDING;
          resolve({ name: file.name, ok: true, tone: s.tone, message: s.text });
        } else resolve({ name: file.name, ok: false, tone: "red", message: body.error ?? `Upload failed (error ${xhr.status}). Nothing was saved.` });
      };
      xhr.onerror = () => resolve({ name: file.name, ok: false, tone: "red", message: "Couldn't reach our server — check your connection and try again. Nothing was saved." });
      xhr.send(fd);
    });
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fields = new FormData(e.currentTarget);
    const files = fields.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
    setError(null);
    if (!fields.get("year")) return setError("Choose the tax year, or “Not sure”.");
    if (!fields.get("docType")) return setError("Choose what kind of document you're uploading.");
    if (!files.length) return setError("Choose at least one file (PDF, photo or scan).");
    setBusy(true);
    const out: Result[] = [];
    for (const f of files) out.push(await send(f, fields));
    setResults(out);
    setProgress(null);
    setBusy(false);
    if (out.every((r) => r.ok)) formRef.current?.reset();
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-4" data-testid="tax-upload-form" noValidate>
      <input type="hidden" name="account" value={account} />
      <label className="block text-sm font-semibold text-navy-900">
        Tax year
        <select className="input mt-1" name="year" defaultValue={defaultYear}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
          <option value="unsure">Not sure</option>
        </select>
      </label>
      <label className="block text-sm font-semibold text-navy-900">
        What are you uploading?
        <select className="input mt-1" name="docType" defaultValue="">
          <option value="">Choose a category…</option>
          {Object.entries(categories).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label className="block text-sm font-semibold text-navy-900">
        Short description (optional)
        <input className="input mt-1" name="title" placeholder="e.g. 1099-NEC from Acme" />
      </label>
      <label className="block text-sm font-semibold text-navy-900">
        Files — PDF, photo or scan, up to 5 MB each
        <input className="input mt-1" type="file" name="file" multiple accept="application/pdf,image/*" data-testid="upload-files" />
        <span className="mt-1 block text-xs font-normal text-slate-600">On a phone you can take a photo or choose one from your library.</span>
      </label>
      {progress && (
        <div aria-live="polite" data-testid="upload-progress">
          <p className="text-sm">Uploading {progress.file}… {progress.pct}%</p>
          <div className="h-2 overflow-hidden rounded-full bg-ivory-200"><div className="h-full bg-gold-500 transition-all" style={{ width: `${progress.pct}%` }} /></div>
        </div>
      )}
      {error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-800">{error}</p>}
      <button type="submit" disabled={busy} className="w-full rounded-xl bg-navy-900 px-4 py-3 font-semibold text-white hover:bg-navy-800 disabled:opacity-60">{busy ? "Uploading…" : "Upload securely"}</button>
      {results.length > 0 && (
        <ul className="space-y-2" aria-live="polite" data-testid="upload-results">
          {results.map((r, i) => (
            <li key={i} className={`rounded-lg px-3 py-2 text-sm ${r.tone === "green" ? "bg-emerald-50 text-emerald-900" : r.tone === "amber" ? "bg-amber-50 text-amber-900" : "bg-red-50 text-red-900"}`}>
              <strong>{r.name}</strong> — {r.message}
            </li>
          ))}
          {results.some((r) => r.ok) && <li className="text-sm"><a className="font-semibold underline" href={vaultHref}>See it in your Document Vault</a></li>}
        </ul>
      )}
    </form>
  );
}
