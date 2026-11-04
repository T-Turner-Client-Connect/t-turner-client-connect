// Appointment services Tabitha offers for online booking, with their lengths.
// Pure data: safe to import from client components and the server.

export type ServiceKey =
  | "TAX_1040"
  | "TAX_1040_SCH_C"
  | "RETURN_1065"
  | "RETURN_1041"
  | "RETURN_1120S"
  | "AMENDED_1040X"
  | "BOOKKEEPING_SETUP"
  | "BUSINESS_FORMATION"
  | "CONSULTATION"
  | "PAYROLL_SETUP";

export type AppointmentService = {
  key: ServiceKey;
  name: string;
  description: string;
  minutes: number;
  // Plain wording for texts (no special characters, no tax details).
  smsLabel: string;
  // A business service: the Booking Information step asks for the business name.
  // Booking one never grants business or bookkeeping portal access.
  business: boolean;
  icon: "file" | "briefcase" | "handshake" | "landmark" | "building" | "filePen" | "calculator" | "rocket" | "messages" | "wallet";
};

export const APPOINTMENT_SERVICES: AppointmentService[] = [
  { key: "TAX_1040", name: "Taxes — 1040", description: "Individual tax return (Form 1040)", minutes: 60, smsLabel: "Individual Tax Return", business: false, icon: "file" },
  { key: "TAX_1040_SCH_C", name: "1040 Schedule C", description: "Business income (Schedule C)", minutes: 90, smsLabel: "Schedule C Tax Return", business: false, icon: "briefcase" },
  { key: "RETURN_1065", name: "1065 — Bookkeeping Client", description: "Partnership return / Bookkeeping", minutes: 120, smsLabel: "Partnership Return", business: true, icon: "handshake" },
  { key: "RETURN_1041", name: "1041 — Estate/Trust Return", description: "Estate and trust tax return", minutes: 45, smsLabel: "Estate/Trust Return", business: false, icon: "landmark" },
  { key: "RETURN_1120S", name: "1120-S — Bookkeeping Client", description: "S Corporation return / Bookkeeping", minutes: 120, smsLabel: "S Corporation Return", business: true, icon: "building" },
  { key: "AMENDED_1040X", name: "Amended Tax Return — 1040-X", description: "Amend a previously filed return", minutes: 120, smsLabel: "Amended Return", business: false, icon: "filePen" },
  { key: "BOOKKEEPING_SETUP", name: "Bookkeeping Setup Services", description: "Setup, onboarding and configuration", minutes: 90, smsLabel: "Bookkeeping Setup", business: true, icon: "calculator" },
  { key: "BUSINESS_FORMATION", name: "Business Setup / Formation", description: "Form and register a new business (LLC, Corporation, or Partnership)", minutes: 120, smsLabel: "Business Formation", business: true, icon: "rocket" },
  { key: "CONSULTATION", name: "Consultation", description: "Tax, business, or financial consultation", minutes: 60, smsLabel: "Consultation", business: false, icon: "messages" },
  { key: "PAYROLL_SETUP", name: "Payroll Setup", description: "Initial payroll setup and configuration", minutes: 60, smsLabel: "Payroll Setup", business: true, icon: "wallet" },
];

/** No appointment is ever longer than two hours. */
export const MAX_APPOINTMENT_MINUTES = 120;
/** Every length a booking can have (for precomputing open times). */
export const APPOINTMENT_LENGTHS = Array.from(new Set(APPOINTMENT_SERVICES.map((s) => Math.min(s.minutes, MAX_APPOINTMENT_MINUTES)))).sort((a, b) => a - b);

const BY_KEY = new Map(APPOINTMENT_SERVICES.map((s) => [s.key, s]));

export function serviceByKey(key: string): AppointmentService | undefined {
  return BY_KEY.get(key as ServiceKey);
}

/** Known, de-duplicated service keys in catalog order. Unknown keys are dropped. */
export function cleanServiceKeys(keys: readonly string[]): ServiceKey[] {
  const set = new Set(keys);
  return APPOINTMENT_SERVICES.filter((s) => set.has(s.key)).map((s) => s.key);
}

/** The appointment is as long as the LONGEST selected service, capped at two hours. */
export function appointmentMinutes(keys: readonly string[]): number {
  const longest = Math.max(0, ...cleanServiceKeys(keys).map((k) => BY_KEY.get(k)!.minutes));
  return Math.min(longest, MAX_APPOINTMENT_MINUTES);
}

export function durationLabel(min: number): string {
  if (min < 60) return `${min} min`;
  const h = min / 60;
  return h === 1 ? "1 hr" : `${Number.isInteger(h) ? h : h.toFixed(1)} hrs`;
}

/** "2 hours (maximum)" in the summary panel. */
export function totalTimeLabel(min: number): string {
  if (!min) return "—";
  const words = min < 60 ? `${min} minutes` : min === 60 ? "1 hour" : `${Number.isInteger(min / 60) ? min / 60 : (min / 60).toFixed(1)} hours`;
  return min >= MAX_APPOINTMENT_MINUTES ? `${words} (maximum)` : words;
}

export function serviceNames(keys: readonly string[]): string[] {
  return cleanServiceKeys(keys).map((k) => BY_KEY.get(k)!.name);
}

export function smsServiceText(keys: readonly string[]): string {
  const names = cleanServiceKeys(keys).map((k) => BY_KEY.get(k)!.smsLabel);
  if (names.length <= 1) return names[0] ?? "your appointment";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function hasBusinessService(keys: readonly string[]) {
  return cleanServiceKeys(keys).some((k) => BY_KEY.get(k)!.business);
}

export const MEETING_TYPES = {
  IN_OFFICE: "In office",
  PHONE: "Phone",
  VIRTUAL: "Virtual (video)",
} as const;
export type MeetingType = keyof typeof MEETING_TYPES;

export const STATUS_LABELS: Record<string, string> = {
  REQUESTED: "Awaiting confirmation",
  CONFIRMED: "Confirmed",
  RESCHEDULE_REQUESTED: "Reschedule requested",
  PROPOSED: "New time proposed",
  DECLINED: "Declined",
  CANCELLED: "Cancelled",
  COMPLETED: "Completed",
  NO_SHOW: "No-show",
};

/** Statuses that hold their time on the calendar. */
export const HOLDING_STATUSES = ["REQUESTED", "CONFIRMED", "RESCHEDULE_REQUESTED", "PROPOSED"] as const;
