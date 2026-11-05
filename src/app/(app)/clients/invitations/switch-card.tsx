import clsx from "clsx";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { portalInvitesSwitchAction } from "@/app/actions/prepared-invitations";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { ownerSwitches } from "@/lib/services/owner-switches";
import { ON_HOLD_MESSAGE } from "@/lib/services/prepared-invitations";
import { fmtDateTime } from "@/lib/format";

/** Tabitha's "Portal invitations authorized" switch: everyone sees its state; only she can flip it. */
export async function InvitesSwitchCard({ back }: { back: string }) {
  const actor = await requireUser();
  const [sw, owner] = await Promise.all([ownerSwitches(), isReportApprover(actor)]);
  const s = sw.portalInvites;
  const by = s.changedById ? (await prisma.user.findUnique({ where: { id: s.changedById }, select: { name: true } }))?.name : null;
  return (
    <section className={clsx("flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4", s.on ? "border-emerald-200 bg-emerald-50" : "border-gold-300 bg-gold-50")} data-testid="invites-switch" data-on={s.on ? "true" : "false"}>
      <div className="flex min-w-0 items-start gap-3">
        {s.on ? <ShieldCheck className="mt-0.5 size-6 shrink-0 text-emerald-700" aria-hidden /> : <ShieldOff className="mt-0.5 size-6 shrink-0 text-gold-700" aria-hidden />}
        <div className="min-w-0">
          <p className="font-semibold text-navy-900">Portal invitations authorized: {s.on ? "On" : "Off"}</p>
          <p className="text-sm text-navy-800">
            {s.on ? "Tabitha can send approved invitations." : `${ON_HOLD_MESSAGE} Preparing and approving still work.`}{" "}
            <span className="text-xs text-slate-600">{s.changedAt ? `Last changed ${fmtDateTime(s.changedAt)} by ${by ?? "the owner"}.` : "Off by default; never changed."}</span>
          </p>
        </div>
      </div>
      {owner && (
        <ActionForm
          action={portalInvitesSwitchAction.bind(null, !s.on, back)}
          confirm={s.on ? "Put portal invitations on hold? Nothing more will be sent until you authorize them again." : "Authorize portal invitations? Approved invitations can then be sent when you press Send."}
        >
          <button type="submit" className={clsx("inline-flex min-h-10 items-center rounded-lg px-4 py-2 text-sm font-semibold shadow", s.on ? "border-[1.5px] border-navy-900 bg-white text-navy-900" : "bg-navy-900 text-white hover:bg-navy-800")} data-testid="toggle-invites-switch">
            {s.on ? "Put on hold" : "Authorize invitations"}
          </button>
        </ActionForm>
      )}
    </section>
  );
}
