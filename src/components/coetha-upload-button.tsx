"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Paperclip, X } from "lucide-react";

const MAX_FILES = 3;
const MAX_BYTES = 5 * 1024 * 1024;
type Picked = { file: File; preview: string | null };

/**
 * Ask Coetha's "Upload Files" button: picks up to three PDFs or pictures (check images, bank
 * statements, receipts, invoices) to send with the question, and shows each one (a thumbnail for
 * pictures, an icon for PDFs) with its name, size and a remove (x). The input keeps the name
 * "file", so the form posts every chosen file; the server checks them again.
 */
export function CoethaUploadButton() {
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  // Thumbnails are temporary browser links; free them when the list changes.
  useEffect(() => () => picked.forEach((p) => p.preview && URL.revokeObjectURL(p.preview)), [picked]);

  // The form is cleared after Coetha answers; clear the list with it.
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    const clear = () => { setPicked([]); setProblem(null); };
    form.addEventListener("reset", clear);
    return () => form.removeEventListener("reset", clear);
  }, []);

  const sync = (files: File[]) => {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    if (input.current) input.current.files = dt.files;
    setPicked(files.map((file) => ({ file, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null })));
    const total = files.reduce((n, f) => n + f.size, 0);
    setProblem(files.length > MAX_FILES ? `Send up to ${MAX_FILES} files with one question.` : total > MAX_BYTES ? "These files are over 5 MB in all. Remove one or send them one at a time." : null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-navy-900 bg-white px-4 py-2 text-sm font-semibold text-navy-900 shadow-sm hover:bg-ivory-100 focus-within:ring-2 focus-within:ring-gold-300" data-testid="coetha-chat-upload">
        <Paperclip className="size-4 text-gold-600" aria-hidden />
        Upload Files
        <input
          ref={input}
          type="file"
          name="file"
          multiple
          accept="application/pdf,image/png,image/jpeg,image/gif,image/webp"
          className="sr-only"
          data-testid="coetha-chat-file"
          aria-label="Upload files for Coetha"
          onChange={(e) => sync(Array.from(e.target.files ?? []))}
        />
      </label>
      {picked.length > 0 && (
        <ul className="space-y-1" data-testid="coetha-chat-files" aria-label="Files to send">
          {picked.map((p, i) => (
            <li key={`${p.file.name}-${i}`} className="flex min-w-0 items-center gap-2 rounded-lg bg-ivory-100 p-1.5 text-xs text-navy-900 ring-1 ring-ivory-200" data-testid="coetha-chat-file-name">
              {p.preview
                // eslint-disable-next-line @next/next/no-img-element -- a local preview of the picked file, not a site image
                ? <img src={p.preview} alt="" className="size-9 shrink-0 rounded object-cover ring-1 ring-ivory-300" />
                : <span className="flex size-9 shrink-0 items-center justify-center rounded bg-white ring-1 ring-ivory-300"><FileText className="size-5 text-navy-700" aria-hidden /></span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold" title={p.file.name}>{p.file.name}</span>
                <span className="text-slate-600">{p.file.size >= 1024 * 1024 ? `${(p.file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(p.file.size / 1024))} KB`}</span>
              </span>
              <button type="button" className="rounded-full p-1 hover:bg-ivory-200" aria-label={`Remove ${p.file.name}`} onClick={() => sync(picked.filter((_, j) => j !== i).map((x) => x.file))}>
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem && <p className="text-xs font-semibold text-red-700" role="alert">{problem}</p>}
    </div>
  );
}
