export const STATE_LABELS: Record<string, { label: string; tone: "navy" | "gold" | "green" | "red" | "gray" | "amber" }> = {
  DRAFT: { label: "Draft", tone: "gray" },
  OFFERED: { label: "Awaiting client acceptance", tone: "gold" },
  ACCEPTED: { label: "Accepted", tone: "navy" },
  ISSUED: { label: "Issued", tone: "navy" },
  DECLINED: { label: "Declined", tone: "amber" },
  VOID: { label: "Void", tone: "gray" },
};

export const METHOD_LABELS: Record<string, string> = { CASH: "Cash", CHECK: "Check", CARD: "Card", ACH: "Bank transfer (ACH)", ZELLE: "Zelle", CASH_APP: "Cash App", OTHER: "Other" };
