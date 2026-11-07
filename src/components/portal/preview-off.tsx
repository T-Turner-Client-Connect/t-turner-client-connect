import type { ReactNode } from "react";
import { PREVIEW_OFF_NOTE } from "@/lib/portal/preview-off";

/** The note under every control View as Client shows but turns off. */
export function PreviewOffNote({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs font-semibold text-gold-700 ${className}`} data-testid="preview-off">
      {PREVIEW_OFF_NOTE}
    </p>
  );
}

/**
 * In View as Client, shows the client's form exactly as they see it but disabled (a disabled
 * fieldset turns off every input and button inside it), with the note. Outside the preview it
 * renders the children unchanged. The server refuses these actions too: the preview only ever
 * passes the preview stand-in actions, which save nothing.
 */
export function PreviewDisabled({ readOnly, children, className }: { readOnly?: boolean; children: ReactNode; className?: string }) {
  if (!readOnly) return <>{children}</>;
  return (
    <fieldset disabled aria-disabled className={`min-w-0 cursor-not-allowed opacity-80 ${className ?? ""}`} data-testid="preview-disabled">
      {children}
      <PreviewOffNote className="mt-2" />
    </fieldset>
  );
}

/** View as Client of a client with no portal login, on a page that belongs to a login. */
export function NoPortalLoginNotice() {
  return (
    <p className="rounded-xl border border-gold-300 bg-gold-50/70 px-4 py-3 text-sm text-navy-900" data-testid="preview-no-login">
      This client hasn&apos;t set up a portal login yet. This page shows things tied to their own login, so it fills in once they sign in.
    </p>
  );
}
