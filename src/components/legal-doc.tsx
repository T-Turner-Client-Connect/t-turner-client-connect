import type { ReactNode } from "react";

export function LegalDoc({ title, effective, children }: { title: string; effective: string; children: ReactNode }) {
  return (
    <article className="rounded-2xl border border-ivory-200 bg-white p-6 shadow-sm sm:p-10">
      <h1 className="text-3xl font-bold sm:text-4xl">{title}</h1>
      <p className="mt-2 text-sm text-slate-600">Effective date: {effective}</p>
      <div className="mt-6 space-y-6 text-[16px] leading-relaxed text-slate-800 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold">{children}</div>
    </article>
  );
}
