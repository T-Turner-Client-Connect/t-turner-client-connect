import clsx from "clsx";
import { Check, Lock } from "lucide-react";
import { ACTION_LABELS, AREAS, keyOf, type ActionDef, type Area, type PermAction, type PermKey } from "@/lib/permissions";

/** The six standard columns; finer actions (Record payments, Refund, Void…) sit in "More". */
const COLUMNS: PermAction[] = ["view", "create", "edit", "approve", "send", "manage"];

type Mode = { kind: "owner" } | { kind: "readonly" } | { kind: "edit"; mayChange: (k: PermKey) => boolean };

function Cell({ area, def, held, mode, standard }: { area: Area; def: ActionDef; held: boolean; mode: Mode; standard: boolean }) {
  const key = keyOf(area, def.key);
  const label = ACTION_LABELS[def.key];
  const ownerOnly = !!def.ownerOnly;
  const checked = mode.kind === "owner" || (held && !ownerOnly);
  const editable = mode.kind === "edit" && !ownerOnly && mode.mayChange(key);
  const tip = `${label}: ${def.description}${def.reserved ? " (Nothing uses this yet.)" : ""}`;
  return (
    <label
      title={tip}
      data-perm={key}
      data-checked={checked ? "yes" : "no"}
      className={clsx(
        "group inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold select-none",
        standard && "md:min-h-0 md:justify-center md:border-0 md:bg-transparent md:p-0",
        ownerOnly && mode.kind !== "owner" ? "border-gold-200 bg-gold-50 text-gold-700" : checked ? "border-navy-900 bg-navy-900 text-white" : "border-ivory-200 bg-white text-navy-900",
        standard && "md:text-navy-900",
        editable ? "cursor-pointer hover:border-gold-500" : "cursor-default",
      )}
    >
      {editable ? (
        <input type="checkbox" name="perm" value={key} defaultChecked={checked} className="size-4 accent-[#0a1a44]" aria-label={`${label}`} />
      ) : ownerOnly && mode.kind !== "owner" ? (
        <Lock className="size-3.5" aria-hidden />
      ) : (
        <>
          {/* Read-only: keep what's held when a delegated manager saves without the right to change it. */}
          {mode.kind === "edit" && checked && <input type="hidden" name="perm" value={key} />}
          <span className={clsx("inline-flex size-4 items-center justify-center rounded border", checked ? "border-gold-500 bg-gold-500 text-navy-950" : "border-slate-300 bg-slate-100")} aria-hidden>
            {checked && <Check className="size-3" strokeWidth={3} />}
          </span>
        </>
      )}
      <span className={clsx(standard && "md:sr-only")}>{label}</span>
      {ownerOnly && mode.kind !== "owner" && <span className="font-normal">· Owner only</span>}
      {def.reserved && <sup className="text-[10px] font-normal opacity-70" aria-label="not used yet">†</sup>}
      {!editable && !(ownerOnly && mode.kind !== "owner") && <span className="sr-only">{checked ? "allowed" : "not allowed"}</span>}
    </label>
  );
}

/**
 * Areas × actions. Desktop: a grid with the six standard columns plus "More". Phone: one card
 * per area with every action as a toggle chip. Works without JavaScript (plain checkboxes).
 */
export function PermissionMatrix({ held, mode }: { held: ReadonlySet<string>; mode: Mode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-ivory-200" data-testid="permission-matrix">
      <div className="hidden bg-navy-900 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-navy-100 md:grid md:grid-cols-[minmax(170px,1.2fr)_repeat(6,50px)_minmax(150px,1fr)] md:items-center md:gap-1.5">
        <span>Area</span>
        {COLUMNS.map((c) => <span key={c} className="text-center">{ACTION_LABELS[c]}</span>)}
        <span>More</span>
      </div>
      <ul className="divide-y divide-ivory-200">
        {AREAS.map((area, i) => {
          const actions = area.actions as readonly ActionDef[];
          const more = actions.filter((a) => !COLUMNS.includes(a.key));
          return (
            <li key={area.key} data-area={area.key} className={clsx("grid gap-2 px-3 py-3 md:gap-1.5 md:grid-cols-[minmax(170px,1.2fr)_repeat(6,50px)_minmax(150px,1fr)] md:items-center", i % 2 ? "bg-ivory-100" : "bg-white")}>
              <div>
                <p className="font-semibold text-navy-900">{area.label}</p>
                <p className="text-xs text-slate-600">{area.description}</p>
              </div>
              <div className="flex flex-wrap gap-1.5 md:contents">
                {COLUMNS.map((c) => {
                  const def = actions.find((a) => a.key === c);
                  return def ? (
                    <div key={c} className="md:flex md:justify-center"><Cell area={area.key} def={def} held={held.has(keyOf(area.key, c))} mode={mode} standard /></div>
                  ) : (
                    <span key={c} className="hidden text-center text-slate-300 md:block" aria-hidden>—</span>
                  );
                })}
                <div className="flex flex-wrap gap-1.5">
                  {more.map((def) => <Cell key={def.key} area={area.key} def={def} held={held.has(keyOf(area.key, def.key))} mode={mode} standard={false} />)}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
