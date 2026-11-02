"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { syncSquareBillingAction } from "@/app/actions/square-billing";

/** Re-reads the linked Square billing (read only) when the card opens with figures older than ~50 minutes. */
export function SquareAutoRefresh({ arrangementId, due }: { arrangementId: string; due: boolean }) {
  const router = useRouter();
  const ran = useRef(false);
  const [state, setState] = useState<"idle" | "running" | "failed">("idle");
  useEffect(() => {
    if (!due || ran.current) return;
    ran.current = true;
    setState("running");
    syncSquareBillingAction(arrangementId, null)
      .then((r) => {
        setState(r?.error ? "failed" : "idle");
        router.refresh();
      })
      .catch(() => setState("failed"));
  }, [arrangementId, due, router]);
  if (state === "running") return <p className="text-xs text-slate-600" role="status" data-testid="square-refreshing">Refreshing from Square (read only)…</p>;
  if (state === "failed") return <p className="text-xs text-red-700" role="status">Square couldn&apos;t be read just now — the figures below are the last verified ones.</p>;
  return null;
}
