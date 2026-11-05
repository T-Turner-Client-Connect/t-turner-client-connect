"use client";

import { Printer } from "lucide-react";

/** Prints the current page (navigation and buttons are hidden with print:hidden). */
export function WindowPrintButton({ label = "Print" }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-navy-700 bg-white px-4 py-2 text-sm font-semibold text-navy-900 hover:bg-navy-50 print:hidden"
    >
      <Printer className="size-4" aria-hidden /> {label}
    </button>
  );
}
