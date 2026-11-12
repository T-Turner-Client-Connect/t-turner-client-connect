import "server-only";
import type { AcceptedFilingInput, DeliverInput, DeliveryResult } from "@/lib/services/accepted-returns";
import { str } from "@/lib/action";

// Reads the "Finish & Send a Return" form (Taxes tab, Documents tab inline, bulk rows).

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

export const ownerFrom = (fd: FormData) => ({ form8879Confirmed: fd.get("form8879") === "on", overrideReason: str(fd, "overrideReason") || null, filingNow: fd.get("filingNow") === "on" });

/** The inline result: "Sent to client: 2025 1040 Federal + 2025 40 AL". */
export function summarize(r: { results: DeliveryResult[]; owner: boolean }, taxYear: number) {
  const name = (x: DeliveryResult) => `${taxYear} ${x.returnType} ${x.jurisdiction === "FEDERAL" ? "Federal" : x.jurisdiction}`;
  if (r.owner) {
    const sent = r.results.filter((x) => x.sent);
    const kept = r.results.filter((x) => !x.sent);
    return [sent.length ? `Sent to client: ${sent.map(name).join(" + ")}.` : "", kept.length ? `Marked Accepted, not sent yet: ${kept.map(name).join(" + ")} (use “Send to client” on the return).` : ""].filter(Boolean).join(" ");
  }
  return `Sent to Tabitha for release: ${r.results.map(name).join(" + ")}. Nothing reaches the client until she confirms.`;
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
    notifyText: fd.get("notifyText") === "on",
  };
}

