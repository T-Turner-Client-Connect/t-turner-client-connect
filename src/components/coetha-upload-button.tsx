"use client";

import { useEffect, useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";

/**
 * Ask Coetha's "Upload document" button: picks one PDF or picture to send with the question and
 * shows its name. The file input keeps the name "file", so the form posts it as before.
 */
export function CoethaUploadButton() {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState<string | null>(null);

  // The form is cleared after Coetha answers; clear the name with it.
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    const clear = () => setName(null);
    form.addEventListener("reset", clear);
    return () => form.removeEventListener("reset", clear);
  }, []);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <label className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-navy-900 bg-white px-4 py-2 text-sm font-semibold text-navy-900 hover:bg-ivory-100 focus-within:ring-2 focus-within:ring-gold-300" data-testid="coetha-chat-upload">
        <Paperclip className="size-4 text-gold-600" aria-hidden />
        Upload document
        <input
          ref={input}
          type="file"
          name="file"
          accept="application/pdf,image/png,image/jpeg,image/gif,image/webp"
          className="sr-only"
          data-testid="coetha-chat-file"
          aria-label="Upload a document for Coetha"
          onChange={(e) => setName(e.target.files?.[0]?.name ?? null)}
        />
      </label>
      {name && (
        <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-ivory-100 px-3 py-1 text-xs text-navy-900 ring-1 ring-ivory-200" data-testid="coetha-chat-file-name">
          <span className="truncate">{name}</span>
          <button type="button" className="rounded-full p-0.5 hover:bg-ivory-200" aria-label="Remove the document" onClick={() => { if (input.current) input.current.value = ""; setName(null); }}>
            <X className="size-3.5" aria-hidden />
          </button>
        </span>
      )}
    </div>
  );
}
