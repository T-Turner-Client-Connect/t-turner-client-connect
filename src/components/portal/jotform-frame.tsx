"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The Jotform questionnaire inside Client Connect. Jotform tells the page how
 * tall the form is (postMessage "setHeight:<px>:<formId>"), so it fits phones
 * without a second scroll bar. Only messages from jotform.com are accepted.
 */
export function JotformFrame({ src, title }: { src: string; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      let host = "";
      try {
        host = new URL(e.origin).hostname;
      } catch {
        return;
      }
      if (!/(^|\.)jotform\.com$/.test(host) || e.source !== ref.current?.contentWindow) return;
      const parts = typeof e.data === "string" ? e.data.split(":") : [];
      if (parts[0] === "setHeight") {
        const h = Number(parts[1]);
        if (Number.isFinite(h) && h > 200 && h < 20000) setHeight(h + 20);
      }
      if (parts[0] === "scrollIntoView") ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <iframe
      ref={ref}
      src={src}
      title={title}
      className="w-full rounded-2xl border border-ivory-200 bg-white"
      style={{ height: height ?? undefined, minHeight: height ? undefined : "80vh" }}
      allow="fullscreen"
      referrerPolicy="no-referrer"
      data-testid="jotform-frame"
    />
  );
}
