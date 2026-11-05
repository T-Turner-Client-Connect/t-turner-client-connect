import Link from "next/link";
import clsx from "clsx";

/** Owner's Office → Access review sub-tabs (owner only, like the pages themselves). */
export function AccessReviewNav({ current }: { current: "review" | "offboarding" }) {
  const tabs = [
    { key: "review", href: "/owner/access-review", label: "Quarterly review" },
    { key: "offboarding", href: "/owner/access-review/offboarding", label: "Offboarding" },
  ];
  return (
    <nav aria-label="Access review sections" className="-mt-2 mb-5 flex flex-wrap gap-1 rounded-xl bg-white p-1 shadow-sm ring-1 ring-ivory-200 print:hidden">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === current ? "page" : undefined}
          className={clsx("rounded-lg px-3 py-2 text-sm font-semibold", t.key === current ? "bg-navy-900 text-white" : "text-navy-900 hover:bg-navy-50")}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
