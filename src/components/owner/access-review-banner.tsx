import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import clsx from "clsx";

export type AccessReviewBannerData = { title: string; detail: string; stage: "upcoming" | "due" | "overdue" | "quiet"; href: string };

/** Owner's Office alert for the quarterly access review. Rendered only with data the server gave the owner. */
export function AccessReviewBanner({ banner }: { banner: AccessReviewBannerData }) {
  const urgent = banner.stage !== "upcoming";
  return (
    <Link
      href={banner.href}
      data-testid="access-review-banner"
      data-stage={banner.stage}
      className={clsx(
        "mb-4 flex flex-wrap items-center gap-3 rounded-2xl border-2 px-4 py-3 text-navy-950",
        banner.stage === "overdue" ? "border-red-700 bg-red-50 hover:bg-red-100" : urgent ? "border-gold-500 bg-gold-50 hover:bg-gold-100" : "border-navy-700 bg-white hover:bg-navy-50",
      )}
    >
      <ShieldCheck className={clsx("size-6 shrink-0", banner.stage === "overdue" ? "text-red-800" : "text-gold-600")} aria-hidden />
      <span className="min-w-0 flex-1 basis-0">
        <span className="block font-semibold">{banner.title}</span>
        <span className="block text-sm text-slate-700">{banner.detail}</span>
      </span>
      <span className="basis-full pl-9 text-sm font-semibold underline sm:basis-auto sm:pl-0">Owner&apos;s Office → Access review</span>
    </Link>
  );
}
