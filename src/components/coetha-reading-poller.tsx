"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * While Coetha is reading or answering for this business, checks in every few seconds (the check-in
 * only reads her status) and refreshes the page to show her progress and her answer.
 * Leaving the page is fine; the reading continues in the background.
 */
export function CoethaReadingPoller({ clientId, active }: { clientId: string; active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let stop = false;
    let running = false;
    const tick = async () => {
      if (stop || running || document.hidden) return;
      running = true;
      try {
        await fetch("/api/coetha/progress", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId }) });
      } catch {
        // The next check-in tries again.
      } finally {
        running = false;
        if (!stop) router.refresh();
      }
    };
    const t = setInterval(tick, 4000);
    void tick();
    return () => { stop = true; clearInterval(t); };
  }, [active, clientId, router]);
  return null;
}
