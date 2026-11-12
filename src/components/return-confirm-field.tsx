/**
 * Used only when the return reader can't confirm a return's name or year (a scan, a layout it
 * doesn't recognize). Tabitha or an Admin who opened the PDF and checked it types how they checked,
 * and the return is saved in the same upload. A return that shows a different person, year or form
 * is still refused; for anyone else this note is ignored and the file is held for verification.
 */
export function ReturnConfirmField({ className = "" }: { className?: string }) {
  return (
    <details className={`rounded-lg border border-dashed border-ivory-200 p-2 text-sm ${className}`} data-testid="return-confirm">
      <summary className="cursor-pointer text-slate-600">I checked this return (only if it couldn&apos;t be confirmed automatically — Tabitha or an Admin)</summary>
      <label className="mt-2 block">
        <span className="text-xs text-slate-600">How you confirmed it&apos;s this client&apos;s return for this year (for example, “Opened the PDF: Jane Doe, 2023 Form 1040”). Recorded with your name.</span>
        <input className="input mt-1" name="returnConfirmNote" maxLength={500} />
      </label>
    </details>
  );
}
