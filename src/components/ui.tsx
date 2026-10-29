import Link from "next/link";
import clsx from "clsx";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "gold" | "secondary" | "danger" | "ghost";

const variants: Record<Variant, string> = {
  primary: "bg-navy-900 text-white hover:bg-navy-800",
  // Navy text on gold keeps contrast high; gold is an accent, never body text.
  gold: "bg-gold-500 text-navy-950 hover:bg-gold-300",
  secondary: "bg-white text-navy-900 border border-ivory-200 shadow-sm hover:border-navy-700",
  danger: "bg-white text-red-700 border border-red-200 hover:bg-red-50",
  ghost: "text-navy-900 hover:bg-navy-100",
};

export function buttonClass(variant: Variant = "primary", extra?: string) {
  return clsx(
    "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 min-h-10",
    variants[variant],
    extra,
  );
}

export function Button({ variant = "primary", className, ...props }: ComponentProps<"button"> & { variant?: Variant }) {
  return <button className={buttonClass(variant, className)} {...props} />;
}

export function LinkButton({ variant = "primary", className, ...props }: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={buttonClass(variant, className)} {...props} />;
}

export function Card({ className, children, title, actions }: { className?: string; children: ReactNode; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={clsx("rounded-2xl border border-ivory-200 bg-white p-5 shadow-[0_1px_2px_rgba(0,20,82,0.04),0_8px_24px_-12px_rgba(0,20,82,0.12)] sm:p-6", className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-lg font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-ivory-200 pb-5">
      <div>
        <h1 className="text-[1.7rem] font-bold leading-tight tracking-tight sm:text-[2.1rem]">{title}</h1>
        {subtitle && <p className="mt-1 text-slate-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const badgeTones = {
  navy: "bg-navy-100 text-navy-900",
  gold: "bg-gold-100 text-gold-700",
  green: "bg-emerald-50 text-emerald-800",
  red: "bg-red-50 text-red-800",
  gray: "bg-slate-100 text-slate-700",
  amber: "bg-amber-50 text-amber-800",
} as const;

export function Badge({ tone = "navy", children, className }: { tone?: keyof typeof badgeTones; children: ReactNode; className?: string }) {
  return <span className={clsx("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold", badgeTones[tone], className)}>{children}</span>;
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx("block", className)}>
      <span className="mb-1 block text-sm font-semibold text-navy-900">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-600">{hint}</span>}
    </label>
  );
}

export function Notice({ tone = "info", children, title }: { tone?: "info" | "warn" | "error" | "success"; children: ReactNode; title?: string }) {
  const tones = {
    info: "border-navy-100 bg-navy-50 text-navy-900",
    warn: "border-amber-200 bg-amber-50 text-amber-900",
    error: "border-red-200 bg-red-50 text-red-900",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  };
  return (
    <div role={tone === "error" ? "alert" : "status"} className={clsx("rounded-lg border px-4 py-3 text-sm", tones[tone])}>
      {title && <p className="mb-1 font-semibold">{title}</p>}
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-ivory-200 bg-ivory-50 px-6 py-12 text-center">
      <p className="font-serif text-lg text-navy-900">{title}</p>
      {children && <div className="mt-2 text-sm text-slate-600">{children}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, href }: { label: string; value: ReactNode; hint?: ReactNode; href?: string }) {
  const body = (
    <>
      <p className="text-sm font-medium text-slate-600">{label}</p>
      <p className="mt-1 font-serif text-3xl font-bold text-navy-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-600">{hint}</p>}
    </>
  );
  const cls = "block rounded-2xl border border-ivory-200 bg-white p-5 shadow-[0_1px_2px_rgba(0,20,82,0.04),0_8px_24px_-12px_rgba(0,20,82,0.12)] relative overflow-hidden before:absolute before:inset-x-0 before:top-0 before:h-1 before:bg-gradient-to-r before:from-gold-500 before:to-gold-300";
  return href ? (
    <Link href={href} className={clsx(cls, "hover:border-navy-700")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
