"use client";

/**
 * Prints a document from its viewer-bound link. Loads it in a hidden frame
 * and opens the print dialog; if the browser blocks that, opens it in a new
 * tab to print from there.
 */
export function PrintButton({ href, label = "Print" }: { href: string; label?: string }) {
  return (
    <button
      type="button"
      className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-semibold text-navy-900 hover:bg-navy-50"
      onClick={() => {
        const frame = document.createElement("iframe");
        frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
        frame.src = href;
        frame.onload = () => {
          try {
            frame.contentWindow?.focus();
            frame.contentWindow?.print();
          } catch {
            window.open(href, "_blank", "noopener");
          }
          setTimeout(() => frame.remove(), 60_000);
        };
        document.body.appendChild(frame);
      }}
    >
      {label}
    </button>
  );
}
