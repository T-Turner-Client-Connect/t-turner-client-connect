"use client";

import { useState } from "react";
import { Button } from "./ui";

/** Shows a one-time link to the signed-in Admin only, with a copy button. Nothing is stored in the browser. */
export function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 rounded-lg border border-gold/60 bg-ivory p-3">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gold-700">Private link — share only with this person</p>
      <div className="flex flex-wrap gap-2">
        <input className="input min-w-0 flex-1 font-mono text-xs" readOnly value={link} aria-label="Private invitation link" data-testid="private-invite-link" onFocus={(e) => e.currentTarget.select()} />
        <Button
          type="button"
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
    </div>
  );
}
