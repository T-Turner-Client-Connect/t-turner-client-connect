import { Info } from "lucide-react";

/** Pieces shared by the Pricing & Agreements and Billing & Payments pages (navy · gold · white). */

export const tableCard = "min-w-0 overflow-hidden rounded-2xl border border-ivory-200 bg-white shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)]";

export type Tone = "paid" | "partial" | "overdue" | "open" | "pending" | "muted";
const TONES: Record<Tone, string> = {
  paid: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  partial: "bg-gold-50 text-gold-800 ring-gold-300",
  overdue: "bg-red-50 text-red-700 ring-red-200",
  open: "bg-navy-50 text-navy-900 ring-navy-100",
  pending: "bg-amber-50 text-amber-800 ring-amber-200",
  muted: "bg-ivory-50 text-slate-600 ring-ivory-200",
};

export function StatusPill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-3 py-1 text-xs font-bold ring-1 ${TONES[tone]}`}>{children}</span>;
}

/** One headline figure. The first card on Billing & Payments is navy. */
export function StatCard({ icon: Icon, label, value, sub, navy = false, testId }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string; navy?: boolean; testId: string }) {
  return (
    <div
      className={`flex min-w-0 items-center gap-4 rounded-2xl px-5 py-5 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.55)] ${navy ? "bg-gradient-to-br from-navy-900 to-navy-950 text-white ring-1 ring-gold-500/50" : "border border-ivory-200 bg-white"}`}
      data-testid={testId}
    >
      <span className={`flex size-12 shrink-0 items-center justify-center rounded-xl ${navy ? "border border-gold-500/60 bg-white/5" : "border border-gold-300 bg-gold-50"}`}>
        <Icon className={`size-6 ${navy ? "text-gold-400" : "text-gold-600"}`} aria-hidden />
      </span>
      <span className="min-w-0">
        <span className={`block text-sm font-semibold ${navy ? "text-navy-100" : "text-slate-600"}`}>{label}</span>
        <span className={`block font-serif text-2xl font-bold leading-tight sm:text-[1.7rem] ${navy ? "text-gold-300" : "text-navy-900"}`}>{value}</span>
        {sub && <span className={`block text-xs ${navy ? "text-navy-100" : "text-slate-500"}`}>{sub}</span>}
      </span>
    </div>
  );
}

/** Gold-edged note ("Pricing Notice", "Important", "Important Payment Info"). */
export function GoldNote({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-gold-300 bg-gold-50/70 px-5 py-4" data-testid={testId}>
      <Info className="mt-0.5 size-6 shrink-0 text-gold-600" aria-hidden />
      <div className="min-w-0 text-sm text-navy-800">
        <p className="mb-1 font-serif text-lg font-bold text-navy-900">{title}</p>
        {children}
      </div>
    </div>
  );
}

export const usdc = (c: number | null | undefined) => (c == null ? "—" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const ymdLabel = (d: string | null | undefined) => {
  if (!d) return "—";
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day || 1)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
