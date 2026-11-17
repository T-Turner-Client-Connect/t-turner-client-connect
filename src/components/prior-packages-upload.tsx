"use client";

import { useState } from "react";
import { uploadPriorPackageAction } from "@/app/actions/bookkeeping-queue";

/**
 * Drop every client's prior financial package at once (the Jan–Sep statements already sent). Each
 * file goes up on its own, is matched to its client by the name printed in it, and is queued for
 * Coetha to enter the months the books don't have yet.
 */
export function PriorPackagesUpload() {
  const [results, setResults] = useState<{ ok: boolean; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mb-4 rounded-xl border border-ivory-200 bg-white p-3" data-testid="prior-packages">
      <p className="text-sm font-semibold text-navy-900">Prior months from financial packages you already prepared</p>
      <p className="text-xs text-slate-600">Choose all the packages at once (PDF). Each is matched to its client by the name printed in it; Coetha enters only the months the books don&apos;t have yet and reports any difference — nothing is forced to balance.</p>
      <label className="mt-2 inline-flex min-h-10 cursor-pointer items-center rounded-lg bg-gold-500 px-4 py-2 text-sm font-semibold text-navy-900 shadow hover:bg-gold-600 focus-within:ring-2 focus-within:ring-gold-300" data-testid="prior-packages-button">
        {busy ? "Uploading…" : "Upload packages"}
      <input type="file" accept="application/pdf" multiple disabled={busy} className="sr-only" aria-label="Upload financial packages (PDF)" onChange={async (e) => {
        const files = Array.from(e.target.files ?? []);
        if (!files.length) return;
        setBusy(true);
        setResults([]);
        for (const f of files) {
          const fd = new FormData();
          fd.set("file", f);
          const r = await uploadPriorPackageAction(fd).catch(() => ({ ok: false, message: `${f.name}: upload failed; try it again.` }));
          setResults((x) => [...x, r]);
        }
        setBusy(false);
        e.target.value = "";
      }} />
      </label>
      {busy && <p className="mt-1 text-xs font-semibold text-navy-900">Uploading {results.length + 1}…</p>}
      {results.length > 0 && <ul className="mt-2 space-y-0.5 text-xs">{results.map((r, i) => <li key={i} className={r.ok ? "text-emerald-800" : "text-red-800"}>{r.message}</li>)}</ul>}
    </div>
  );
}
