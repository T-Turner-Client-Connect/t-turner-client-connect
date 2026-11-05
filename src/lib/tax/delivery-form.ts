import "server-only";
import type { AcceptedFilingInput, DeliverInput, DeliveryResult } from "@/lib/services/accepted-returns";
import { str } from "@/lib/action";

// Reads the "Deliver accepted return" form (Taxes tab, Documents tab inline, bulk rows).

export async function fileIn(fd: FormData, key: string) {
  const f = fd.get(key);
  return f instanceof File && f.size > 0 ? { bytes: new Uint8Array(await f.arrayBuffer()), originalName: f.name } : null;
}

/** Federal ("fed.*") and state ("st.N.*") rows of the delivery form, optionally prefixed (bulk rows). */
export async function filingsFrom(fd: FormData, p = ""): Promise<AcceptedFilingInput[]> {
  const out: AcceptedFilingInput[] = [];
  if (fd.get(`${p}fed.on`) === "on") {
    out.push({ jurisdiction: "FEDERAL", returnType: str(fd, `${p}fed.returnType`), acceptedOn: str(fd, `${p}fed.acceptedOn`) || null, submissionId: str(fd, `${p}fed.submissionId`) || null, returnFile: await fileIn(fd, `${p}fed.file`), ackFile: await fileIn(fd, `${p}fed.ack`) });
  }
  const idx = new Set<string>();
  for (const k of fd.keys()) {
    const m = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}st\\.(\\d+)\\.on$`).exec(k);
    if (m && fd.get(k) === "on") idx.add(m[1]);
  }
  for (const i of [...idx].sort((a, b) => Number(a) - Number(b))) {
    const q = `${p}st.${i}.`;
    out.push({ jurisdiction: str(fd, `${q}code`), returnType: str(fd, `${q}returnType`), acceptedOn: str(fd, `${q}acceptedOn`) || null, submissionId: str(fd, `${q}submissionId`) || null, returnFile: await fileIn(fd, `${q}file`), ackFile: await fileIn(fd, `${q}ack`) });
  }
  return out;
}

export const ownerFrom = (fd: FormData) => ({ form8879Confirmed: fd.get("form8879") === "on", overrideReason: str(fd, "overrideReason") || null });

export function summarize(r: { results: DeliveryResult[]; owner: boolean }) {
  const name = (x: DeliveryResult) => `${x.jurisdiction === "FEDERAL" ? "Federal" : x.jurisdiction} ${x.returnType}`;
  const accepted = r.results.filter((x) => x.outcome !== "awaiting_owner");
  const waiting = r.results.filter((x) => x.outcome === "awaiting_owner");
  const parts: string[] = [];
  if (accepted.length) parts.push(`${accepted.map(name).join(" and ")}: accepted${accepted.some((x) => x.sent) ? " and sent to the client's vault (shown once the malware scan passes)" : r.owner ? " — use “Send to client” when you're ready" : " — Tabitha releases it to the client"}`);
  if (waiting.length) parts.push(`${waiting.map(name).join(" and ")}: saved as “Ready for Tabitha to confirm acceptance”. Nothing was marked submitted.`);
  return parts.join(". ") + ".";
}

/** Fields shared by the Taxes-tab form and the Documents-tab inline version. */
export async function deliveryFrom(fd: FormData, clientId: string, combined: DeliverInput["combinedReturn"]): Promise<DeliverInput> {
  return {
    clientId,
    taxYear: Number(str(fd, "taxYear") || str(fd, "year")),
    filingType: str(fd, "filingType") === "AMENDED" ? "AMENDED" : "ORIGINAL",
    filings: await filingsFrom(fd),
    combinedReturn: combined,
    verificationNote: str(fd, "verificationNote"),
    owner: ownerFrom(fd),
    relabelAck: fd.get("relabelAck") === "on",
    closeDraftSummary: fd.get("closeDraftSummary") === "on",
    sendToClient: fd.get("sendToClient") === "on",
    notifyClient: fd.get("notifyClient") === "on",
  };
}

