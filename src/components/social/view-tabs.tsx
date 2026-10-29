import Link from "next/link";
import clsx from "clsx";

/** List ⇄ calendar switch shared by both social views. */
export function SocialViewTabs({ active }: { active: "list" | "calendar" | "topics" }) {
  const tabs = [
    { key: "list", href: "/social", label: "List" },
    { key: "calendar", href: "/social/calendar", label: "Calendar" },
    { key: "topics", href: "/social/topics", label: "Content topics" },
  ] as const;
  return (
    <nav aria-label="Social views" className="mb-4 inline-flex rounded-lg border border-navy-100 bg-white p-1">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} aria-current={active === t.key ? "page" : undefined} className={clsx("rounded-md px-4 py-1.5 text-sm font-semibold", active === t.key ? "bg-navy-900 text-white" : "text-navy-900 hover:bg-navy-50")}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
