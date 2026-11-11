"use client";

import { useSyncExternalStore } from "react";
import { X } from "lucide-react";

/**
 * A pinned flyer (e.g. the welcome flyer) as a small pop-up on the client's Home page, shown until
 * the client closes it. Closing is remembered in this browser for this flyer only; the flyer stays
 * in News & Announcements as a normal small item.
 */
const EVENT = "flyer-popup-closed";
const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => { window.removeEventListener(EVENT, cb); window.removeEventListener("storage", cb); };
};
function isClosed(key: string) {
  try { return window.localStorage.getItem(key) === "1"; } catch { return false; }
}

export function FlyerPopup({ id, src, alt, title }: { id: string; src: string; alt: string; title: string }) {
  const key = `flyer-closed:${id}`;
  // Read from this browser's storage; the server render keeps it hidden (no flash).
  const closed = useSyncExternalStore(subscribe, () => isClosed(key), () => true);
  if (closed) return null;
  const close = () => {
    try { window.localStorage.setItem(key, "1"); } catch { /* ignore */ }
    window.dispatchEvent(new Event(EVENT));
  };
  return (
    <div className="fixed bottom-4 right-4 z-40 w-[min(22rem,calc(100vw-2rem))] rounded-2xl bg-white p-2 shadow-xl ring-1 ring-gold-300" role="dialog" aria-label={title} data-testid="flyer-popup">
      <button type="button" onClick={close} className="absolute -right-2 -top-2 grid size-8 place-items-center rounded-full bg-navy-900 text-white shadow ring-2 ring-white" aria-label="Close" data-testid="flyer-popup-close">
        <X className="size-4" aria-hidden />
      </button>
      <a href={src} target="_blank" rel="noopener" aria-label={`${title} (opens the flyer in a new tab)`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} width={1536} height={1024} className="h-auto w-full rounded-xl" />
      </a>
    </div>
  );
}
