import { format, formatDistanceToNow } from "date-fns";

export function fmtDate(d: Date | null | undefined): string {
  return d ? format(d, "MMM d, yyyy") : "—";
}

// Timestamps are shown in the office's time zone (America/Chicago), not the server's.
export function fmtDateTime(d: Date | null | undefined): string {
  return d ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(d) : "—";
}

export function fromNow(d: Date): string {
  return formatDistanceToNow(d, { addSuffix: true });
}

export const CLIENT_TYPE_LABELS = { INDIVIDUAL: "Individual", BUSINESS: "Business", NONPROFIT: "Nonprofit" } as const;
export const CLIENT_STATUS_LABELS = { PROSPECT: "Prospect", ACTIVE: "Active", INACTIVE: "Inactive" } as const;
export const CHANNEL_LABELS = { EMAIL: "Email", SMS: "Text", BOTH: "Email + Text" } as const;
