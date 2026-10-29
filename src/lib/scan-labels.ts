// Plain-language malware-scan states shown to staff (and, for their own uploads, clients).
export const SCAN_LABELS = {
  CLEAN: { tone: "green", text: "Scanned clean", client: "Received" },
  PENDING: { tone: "amber", text: "Quarantined — scan pending", client: "Being checked for viruses" },
  NOT_SCANNED: { tone: "amber", text: "Quarantined — scanner not set up", client: "Being checked for viruses" },
  INFECTED: { tone: "red", text: "Infected — file destroyed", client: "Couldn't be accepted — please upload a different copy" },
} as const;
