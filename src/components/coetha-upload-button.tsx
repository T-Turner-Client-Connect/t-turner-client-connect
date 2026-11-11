"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, FileText, Loader2, Paperclip, RotateCw, X } from "lucide-react";

const ACCEPT = "application/pdf,image/png,image/jpeg,image/gif,image/webp";
const MAX_MB = 60;
type Item = { key: string; file: File; preview: string | null; state: "uploading" | "saved" | "error"; pct: number; jobId?: string; reused?: boolean; error?: string; as?: { accountId: string; month: string; label: string; payroll?: boolean } | null; statement?: string | null };
export type StatementAccount = { id: string; label: string };

async function post(fd: FormData) {
  const res = await fetch("/api/coetha/upload", { method: "POST", body: fd });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "The file couldn't be saved. Try again.");
  return body;
}

/**
 * Ask Coetha's "Upload Files": as many PDFs or pictures as needed (check scans, statements,
 * receipts, invoices), each up to 60 MB. Each file uploads right away in small pieces, is saved to
 * the business (staff-only), and gets a reading job; its job id goes with the question. Coetha
 * reads them in the background, so the page can be left and the answer appears when she's done.
 */
const PAYROLL = "__payroll__";

export function CoethaUploadButton({ clientId, accounts = [], defaultMonth = "", payroll = false }: { clientId: string; accounts?: StatementAccount[]; defaultMonth?: string; /** The business runs payroll: offer "Payroll report". */ payroll?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  // "What are these files?": other documents (Coetha reads them), or one account's statement for a month.
  const [kind, setKind] = useState("");
  const [month, setMonth] = useState(defaultMonth);
  const patch = (key: string, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

  // Thumbnails are temporary browser links; free them when the list is cleared.
  useEffect(() => () => items.forEach((p) => p.preview && URL.revokeObjectURL(p.preview)), [items]);
  // The form is cleared after the question is sent; clear the list with it.
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    const clear = () => setItems([]);
    form.addEventListener("reset", clear);
    return () => form.removeEventListener("reset", clear);
  }, []);

  const upload = async (it: Item) => {
    patch(it.key, { state: "uploading", pct: 0, error: undefined });
    try {
      if (it.file.size > MAX_MB * 1024 * 1024) throw new Error(`Files can be up to ${MAX_MB} MB each. Split a larger scan into two files.`);
      const s = new FormData();
      s.set("step", "start"); s.set("clientId", clientId); s.set("name", it.file.name); s.set("size", String(it.file.size));
      const { uploadId, chunks, chunkSize } = await post(s);
      for (let i = 0; i < chunks; i++) {
        const c = new FormData();
        c.set("step", "chunk"); c.set("uploadId", uploadId); c.set("index", String(i));
        c.set("part", it.file.slice(i * chunkSize, Math.min(it.file.size, (i + 1) * chunkSize)));
        // One retry per piece (a dropped connection shouldn't lose the file).
        await post(c).catch(() => post(c));
        patch(it.key, { pct: Math.round(((i + 1) / chunks) * 95) });
      }
      const f = new FormData();
      f.set("step", "finish"); f.set("uploadId", uploadId);
      if (it.as) { f.set("accountId", it.as.accountId); f.set("month", it.as.month); if (it.as.payroll) f.set("payroll", "1"); }
      const done = await post(f);
      patch(it.key, { state: "saved", pct: 100, jobId: done.jobId, reused: done.reused, statement: done.statement ?? null });
    } catch (err) {
      patch(it.key, { state: "error", error: err instanceof Error ? err.message : "The file couldn't be saved." });
    }
  };

  const add = (files: File[]) => {
    const acct = accounts.find((a) => a.id === kind);
    const as = kind === PAYROLL ? { accountId: "", month, label: `Payroll report, ${month}`, payroll: true } : acct ? { accountId: acct.id, month, label: `${acct.label} statement, ${month}` } : null;
    const fresh = files.map((file, i) => ({ key: `${Date.now()}-${i}-${file.name}`, file, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null, state: "uploading" as const, pct: 0, as }));
    setItems((xs) => [...xs, ...fresh]);
    if (input.current) input.current.value = "";
    // One at a time, so a large batch doesn't swamp the connection.
    void fresh.reduce((p, it) => p.then(() => upload(it)), Promise.resolve());
  };

  const busy = items.some((x) => x.state === "uploading");
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {(accounts.length > 0 || payroll) && (
        <div className="grid gap-1 text-xs text-navy-900" data-testid="coetha-upload-kind">
          <label className="grid gap-0.5">What are these files?
            <select className="input py-1 text-xs" value={kind} onChange={(e) => setKind(e.target.value)} data-testid="coetha-upload-account">
              <option value="">Documents for Coetha to read</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>Statement: {a.label}</option>)}
              {payroll && <option value={PAYROLL}>Payroll report (ADP register)</option>}
            </select>
          </label>
          {kind && (
            <label className="grid gap-0.5">{kind === PAYROLL ? "Payroll month" : "Statement month"}
              <input type="month" className="input py-1 text-xs" value={month} onChange={(e) => setMonth(e.target.value)} required data-testid="coetha-upload-month" />
            </label>
          )}
        </div>
      )}
      <label className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-navy-900 bg-white px-4 py-2 text-sm font-semibold text-navy-900 shadow-sm hover:bg-ivory-100 focus-within:ring-2 focus-within:ring-gold-300" data-testid="coetha-chat-upload">
        <Paperclip className="size-4 text-gold-600" aria-hidden />
        Upload Files
        <input ref={input} type="file" multiple accept={ACCEPT} disabled={!!kind && !/^\d{4}-\d{2}$/.test(month)} className="sr-only" data-testid="coetha-chat-file" aria-label="Upload files for Coetha" onChange={(e) => add(Array.from(e.target.files ?? []))} />
      </label>
      {/* What goes with the question: the reading jobs of the saved files. */}
      {items.filter((x) => x.state === "saved" && x.jobId).map((x) => <input key={x.key} type="hidden" name="jobId" value={x.jobId} />)}
      {busy && <input type="hidden" name="uploadsPending" value="1" />}
      {items.length > 0 && (
        <ul className="max-h-72 space-y-1 overflow-y-auto" data-testid="coetha-chat-files" aria-label="Files for Coetha">
          {items.map((x) => (
            <li key={x.key} className="flex min-w-0 items-center gap-2 rounded-lg bg-ivory-100 p-1.5 text-xs text-navy-900 ring-1 ring-ivory-200" data-testid="coetha-chat-file-name">
              {x.preview
                // eslint-disable-next-line @next/next/no-img-element -- a local preview of the picked file, not a site image
                ? <img src={x.preview} alt="" className="size-9 shrink-0 rounded object-cover ring-1 ring-ivory-300" />
                : <span className="flex size-9 shrink-0 items-center justify-center rounded bg-white ring-1 ring-ivory-300"><FileText className="size-5 text-navy-700" aria-hidden /></span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold" title={x.file.name}>{x.file.name}</span>
                {x.state === "uploading" && <span className="flex items-center gap-1 text-slate-600"><Loader2 className="size-3 animate-spin" aria-hidden />Uploading {x.pct}%</span>}
                {x.as && <span className="block text-slate-600">{x.as.label}</span>}
                {x.state === "saved" && <span className="flex items-center gap-1 text-emerald-700"><CheckCircle2 className="size-3" aria-hidden />{x.reused ? "Already on file: Coetha will use it" : "Saved"}</span>}
                {x.state === "saved" && x.statement && <span className="block text-navy-900" data-testid="coetha-upload-statement">{x.statement}</span>}
                {x.state === "error" && <span className="block text-red-700" role="alert">{x.error}</span>}
              </span>
              {x.state === "error" && <button type="button" className="rounded-full p-1 hover:bg-ivory-200" aria-label={`Try ${x.file.name} again`} onClick={() => upload(x)}><RotateCw className="size-3.5" aria-hidden /></button>}
              {x.state !== "uploading" && <button type="button" className="rounded-full p-1 hover:bg-ivory-200" aria-label={`Remove ${x.file.name}`} onClick={() => setItems((xs) => xs.filter((y) => y.key !== x.key))}><X className="size-3.5" aria-hidden /></button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
