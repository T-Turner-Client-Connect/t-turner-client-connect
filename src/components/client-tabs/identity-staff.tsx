import type { Actor } from "@/lib/auth/actor";
import { Card, Notice } from "@/components/ui";
import { IdentitySection } from "@/components/identity-section";
import { downloadToken } from "@/lib/services/documents";
import { canStaffViewIdentity, staffIdentityOverview } from "@/lib/services/identity";

/** Staff view of a client's Identity Documents (Admins and the assigned staff member only). */
export async function IdentityStaff({ clientId, user }: { clientId: string; user: Actor }) {
  if (!(await canStaffViewIdentity(user, clientId))) {
    return (
      <div id="identity" className="scroll-mt-6">
        <Notice title="Identity Documents">Only an Admin or this client&apos;s assigned staff member can open this section. Social Security cards and birth certificates are Admin-only.</Notice>
      </div>
    );
  }
  const overview = await staffIdentityOverview(user, clientId);
  const pending = overview.reduce((n, o) => n + o.slots.reduce((m, s) => m + s.pending.length, 0), 0);
  return (
    <div id="identity" className="scroll-mt-6">
      <Card title={<>Identity Documents{pending > 0 && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">{pending} pending verification</span>}</>}>
        <IdentitySection overview={overview} mode="staff" clientId={clientId} viewerIsAdmin={user.role === "ADMIN"} linkFor={(id) => `/api/documents/${downloadToken(id, { staffId: user.id })}`} />
      </Card>
    </div>
  );
}
