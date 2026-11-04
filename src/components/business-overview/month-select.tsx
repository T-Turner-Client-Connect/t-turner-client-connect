"use client";
import { useRouter } from "next/navigation";
import { CalendarDays } from "lucide-react";

const label = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
};

/** The gold month picker in the overview banner: changing it reloads the overview for that month. */
export function MonthSelect({ base, value, choices }: { base: string; value: string; choices: string[] }) {
  const router = useRouter();
  return (
    <label className="relative inline-flex items-center gap-2 rounded-xl border-2 border-gold-500 bg-navy-950/70 px-4 py-2.5 text-white shadow-[0_0_20px_-8px_var(--color-gold-500)]">
      <CalendarDays className="size-5 text-gold-400" aria-hidden />
      <span className="sr-only">Month</span>
      <select
        value={value}
        onChange={(e) => router.push(`${base}${base.includes("?") ? "&" : "?"}month=${e.target.value}`)}
        className="appearance-none bg-transparent pr-6 text-base font-semibold text-white focus:outline-none"
        data-testid="overview-month"
      >
        {choices.map((m) => (
          <option key={m} value={m} className="text-navy-900">{label(m)}</option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-4 text-gold-300" aria-hidden>▾</span>
    </label>
  );
}
