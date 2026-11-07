"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import clsx from "clsx";
import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Building2,
  CalendarCheck2,
  CalendarDays,
  Calculator,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock,
  FilePen,
  FileText,
  Handshake,
  Info,
  Landmark,
  MessagesSquare,
  Pencil,
  Rocket,
  Wallet,
} from "lucide-react";
import { APPOINTMENT_SERVICES, appointmentMinutes, durationLabel, hasBusinessService, MEETING_TYPES, serviceByKey, totalTimeLabel, type AppointmentService } from "@/lib/appointments/services";
import { dateLabel, timeLabel } from "@/lib/appointments/availability";
import type { BookResult } from "@/app/actions/appointments";

type Month = { year: number; month: number; published: boolean; days: Record<string, Record<number, string[]>> };
type Profile = { legalName: string; phone: string; email: string; existingClient: boolean; businessName: string | null; businessAccount: boolean; smsConsentOnFile: boolean };

const ICONS: Record<AppointmentService["icon"], React.ComponentType<{ className?: string }>> = {
  file: FileText,
  briefcase: Briefcase,
  handshake: Handshake,
  landmark: Landmark,
  building: Building2,
  filePen: FilePen,
  calculator: Calculator,
  rocket: Rocket,
  messages: MessagesSquare,
  wallet: Wallet,
};

const STEPS = ["Select Service(s)", "Choose Date", "Choose Time", "Confirm & Book"];
const card = "min-w-0 rounded-2xl border border-gold-500/40 bg-white p-4 text-navy-900 shadow-[0_24px_48px_-28px_rgb(0_0_0/0.8)] sm:p-5";
const colTitle = "flex items-center gap-2 font-serif text-xl font-bold text-navy-900 sm:text-xl";
const goldBtn = "inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-gold-300 to-gold-500 px-5 py-4 text-lg font-bold text-navy-950 shadow-[0_10px_24px_-12px_rgb(200_157_41/0.9)] ring-1 ring-gold-200 transition hover:to-gold-400 disabled:cursor-not-allowed disabled:opacity-50";

function Num({ n }: { n: number }) {
  return <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gold-500 text-sm font-bold text-navy-950">{n}</span>;
}

export function StepBar({ step }: { step: number }) {
  return (
    <ol className="grid grid-cols-4 gap-1 sm:gap-3" aria-label="Booking steps" data-testid="step-bar">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const done = n < step;
        const current = n === step;
        return (
          <li key={label} className="flex min-w-0 flex-col items-center gap-1.5 text-center sm:flex-row sm:gap-2 sm:text-left" aria-current={current ? "step" : undefined}>
            <span
              className={clsx(
                "flex size-9 shrink-0 items-center justify-center rounded-full border-2 font-serif text-base font-bold sm:size-10",
                done || current ? "border-gold-400 bg-gradient-to-b from-gold-300 to-gold-500 text-navy-950" : "border-gold-500/70 text-gold-300",
                current && "ring-4 ring-gold-500/25",
              )}
            >
              {done ? <Check className="size-5" aria-hidden /> : n}
            </span>
            <span className={clsx("text-[11px] font-semibold leading-tight sm:text-sm", current ? "text-white" : "text-navy-100/80")}>{label}</span>
            {n < 4 && <span className="hidden h-px flex-1 bg-gold-500/40 lg:block" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

export function DecorPanel() {
  return (
    <aside className="min-w-0 rounded-2xl border border-gold-500/50 bg-gradient-to-b from-navy-900 to-navy-950 p-5 text-white" data-testid="decor-panel">
      <p className="font-serif text-xl font-bold leading-snug">
        Professional Tax &amp; <span className="text-gold-300">Business Services</span>
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm text-navy-100 sm:grid-cols-1">
        {["Tax Preparation", "Bookkeeping", "Payroll", "Business Formation", "Consultations", "And More"].map((t) => (
          <li key={t} className="flex items-center gap-2">
            <CircleCheck className="size-4 shrink-0 text-gold-400" aria-hidden />
            {t}
          </li>
        ))}
      </ul>
      <p className="mt-4 border-t border-gold-500/30 pt-3 font-serif text-[15px] italic leading-snug text-gold-200">Year-Round Appointments for Taxes, Bookkeeping &amp; Business Services</p>
    </aside>
  );
}

function monthName(y: number, m: number) {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

export function AppointmentBooking(props: {
  clientId: string;
  accountQuery: string;
  initial: Month;
  today: string;
  profile: Profile;
  meetingTypes: string[];
  requireApproval: boolean;
  smsConsentText: string;
  officePhone: string;
  reschedule?: { id: string; services: string[]; durationMin: number; current: string };
  loadMonth: (clientId: string, year: number, month: number, rescheduleId?: string) => Promise<Month | { error: string }>;
  book: (clientId: string, payload: { services: string[]; date: string; time: string; info: Record<string, unknown> }) => Promise<BookResult>;
  reschedulePick: (clientId: string, appointmentId: string, date: string, time: string) => Promise<{ error?: string; ok?: string }>;
  /** View as Client: everything can be clicked through, but Confirm & Book is turned off. */
  readOnly?: boolean;
}) {
  const { reschedule } = props;
  const [selected, setSelected] = useState<string[]>(reschedule?.services ?? []);
  const [months, setMonths] = useState<Record<string, Month>>({ [`${props.initial.year}-${props.initial.month}`]: props.initial });
  const [ym, setYm] = useState({ y: props.initial.year, m: props.initial.month });
  const [date, setDate] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [view, setView] = useState<"pick" | "info" | "done">("pick");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<NonNullable<BookResult["ok"]> | null>(null);
  const [rescheduledNote, setRescheduledNote] = useState<string | null>(null);

  const minutes = reschedule ? reschedule.durationMin : appointmentMinutes(selected);
  const current = months[`${ym.y}-${ym.m}`];
  const openDays = useMemo(() => {
    const out = new Set<string>();
    if (!current || !minutes) return out;
    for (const [d, byLen] of Object.entries(current.days)) if (byLen[minutes]?.length) out.add(d);
    return out;
  }, [current, minutes]);
  const times = date && current ? current.days[date]?.[minutes] ?? [] : [];
  const step = view !== "pick" ? 4 : !selected.length ? 1 : !date ? 2 : !time ? 3 : 4;

  const goMonth = (delta: number) => {
    const d = new Date(Date.UTC(ym.y, ym.m - 1 + delta, 1));
    const next = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
    const [ty, tm] = props.today.split("-").map(Number);
    if (next.y * 12 + next.m < ty * 12 + tm) return;
    setYm(next);
    setDate(null);
    setTime(null);
    const key = `${next.y}-${next.m}`;
    if (!months[key]) {
      start(async () => {
        const r = await props.loadMonth(props.clientId, next.y, next.m, reschedule?.id);
        if ("error" in r) setError(r.error);
        else setMonths((m) => ({ ...m, [key]: r }));
      });
    }
  };

  const reloadMonth = () => {
    const key = `${ym.y}-${ym.m}`;
    start(async () => {
      const r = await props.loadMonth(props.clientId, ym.y, ym.m, reschedule?.id);
      if (!("error" in r)) setMonths((m) => ({ ...m, [key]: r }));
    });
  };

  const toggle = (key: string) => {
    if (reschedule) return;
    setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : APPOINTMENT_SERVICES.filter((x) => x.key === key || s.includes(x.key)).map((x) => x.key)));
    setTime(null);
  };

  // --- Booking Information -------------------------------------------------
  const p = props.profile;
  const business = hasBusinessService(selected) || p.businessAccount;
  const [edit, setEdit] = useState<Record<string, boolean>>({});
  // Anything not on file is asked for directly; what is on file is shown with a "Change" option.
  const onFile: Record<string, boolean> = { legalName: !!p.legalName, phone: !!p.phone, email: !!p.email, clientKind: true, businessName: !!p.businessName };
  const [info, setInfo] = useState({
    legalName: p.legalName,
    phone: p.phone,
    email: p.email,
    clientKind: p.existingClient ? "EXISTING" : "NEW",
    meetingType: props.meetingTypes.length === 1 ? props.meetingTypes[0] : "",
    reason: "",
    businessName: p.businessName ?? "",
    smsConsent: p.smsConsentOnFile,
  });
  const set = (k: keyof typeof info, v: string | boolean) => setInfo((s) => ({ ...s, [k]: v }));

  const submitBooking = () => {
    if (!date || !time) return;
    setError(null);
    start(async () => {
      const r = await props.book(props.clientId, { services: selected, date, time, info });
      if (r.error) {
        setError(r.error);
        if (/no longer available/i.test(r.error)) {
          setView("pick");
          setTime(null);
          reloadMonth();
        }
        return;
      }
      setResult(r.ok!);
      setView("done");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  };

  const continueToInfo = () => {
    if (!date || !time) return;
    setError(null);
    if (reschedule) {
      start(async () => {
        const r = await props.reschedulePick(props.clientId, reschedule.id, date, time);
        if (r.error) {
          setError(r.error);
          reloadMonth();
          setTime(null);
          return;
        }
        setRescheduledNote(r.ok ?? "Saved.");
        setView("done");
      });
      return;
    }
    setView("info");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const summary = (
    <section className={card} data-testid="appointment-summary">
      <h3 className="font-serif text-lg font-bold text-navy-900">Appointment Summary</h3>
      <dl className="mt-3 space-y-3 text-sm">
        <div>
          <dt className="font-semibold text-navy-800">Selected Services ({selected.length})</dt>
          <dd>
            {selected.length ? (
              <ul className="mt-1 space-y-1">
                {selected.map((k) => {
                  const s = serviceByKey(k)!;
                  return (
                    <li key={k} className="flex items-start justify-between gap-3">
                      <span className="flex min-w-0 items-start gap-1.5"><Check className="mt-0.5 size-4 shrink-0 text-gold-600" aria-hidden /><span className="[overflow-wrap:anywhere]">{s.name}</span></span>
                      <span className="shrink-0 text-slate-600">{durationLabel(s.minutes)}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <span className="text-slate-500">None yet</span>
            )}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-ivory-200 pt-3">
          <dt className="font-semibold text-navy-800">Scheduled Date</dt>
          <dd className="text-right" data-testid="summary-date">{date ? dateLabel(date) : "—"}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="font-semibold text-navy-800">Appointment Time</dt>
          <dd className="text-right" data-testid="summary-time">{time ? `${timeLabel(time)} CT` : "—"}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl bg-gold-50 px-3 py-2 ring-1 ring-gold-200">
          <dt className="font-semibold text-navy-900">Total Appointment Time</dt>
          <dd className="text-right font-bold text-navy-900" data-testid="summary-total">{totalTimeLabel(minutes)}</dd>
        </div>
      </dl>
    </section>
  );

  const header = (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-center xl:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="min-w-0">
        <div className="flex items-center gap-4">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl border-2 border-gold-500 sm:size-16">
            <CalendarDays className="size-8 text-gold-400 sm:size-9" aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="font-serif text-2xl font-bold leading-tight text-white sm:text-3xl">
              {reschedule ? "Reschedule an " : "Schedule an "}
              <em className="font-serif font-normal italic text-gold-400 [font-family:'Brush_Script_MT','Segoe_Script','Snell_Roundhand',cursive] sm:text-4xl">Appointment</em>
            </h1>
            <p className="mt-1 text-[15px] text-navy-100 sm:text-lg">
              {reschedule ? `Choose a new date and time for your ${reschedule.current} appointment.` : "Select your service(s), choose a date and time, and book your appointment with our team."}
            </p>
          </div>
        </div>
        <div className="mt-6"><StepBar step={view === "done" ? 5 : step} /></div>
      </div>
      <div className="hidden lg:block"><DecorPanel /></div>
    </div>
  );

  if (view === "done") {
    const when = result ? `${dateLabel(result.date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })} at ${timeLabel(result.time)} CT` : date && time ? `${dateLabel(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })} at ${timeLabel(time)} CT` : "";
    const confirmed = result?.status === "CONFIRMED";
    return (
      <div className="space-y-6" data-testid="booking-done">
        {header}
        <section className="mx-auto max-w-2xl rounded-3xl border border-gold-500/60 bg-white p-6 text-center text-navy-900 shadow-[0_30px_60px_-30px_rgb(0_0_0/0.8)] sm:p-10">
          <span className="mx-auto flex size-20 items-center justify-center rounded-full bg-gradient-to-b from-gold-300 to-gold-500 ring-8 ring-gold-100">
            <Check className="size-11 text-navy-950" aria-hidden />
          </span>
          <h2 className="mt-5 font-serif text-2xl font-bold">
            {rescheduledNote ? "Reschedule " : confirmed ? "Appointment " : "Request "}
            <em className="font-normal italic text-gold-600">{rescheduledNote ? "Received" : confirmed ? "Confirmed" : "Received"}</em>
          </h2>
          <p className="mt-2 text-slate-700">
            {rescheduledNote ?? (confirmed ? "You're all set. A confirmation has been sent to your email." : "Your time is reserved while our office reviews your request. You'll receive a confirmation by email as soon as it's approved.")}
          </p>
          <dl className="mx-auto mt-6 max-w-md space-y-2 rounded-2xl bg-ivory-100 p-4 text-left text-sm ring-1 ring-gold-200">
            {!reschedule && (
              <div className="flex justify-between gap-3"><dt className="font-semibold">Services</dt><dd className="text-right">{selected.map((k) => serviceByKey(k)!.name).join(", ")}</dd></div>
            )}
            <div className="flex justify-between gap-3"><dt className="font-semibold">Date &amp; time</dt><dd className="text-right" data-testid="done-when">{when}</dd></div>
            <div className="flex justify-between gap-3"><dt className="font-semibold">Length</dt><dd className="text-right">{totalTimeLabel(minutes)}</dd></div>
            {!reschedule && info.meetingType && (
              <div className="flex justify-between gap-3"><dt className="font-semibold">Meeting type</dt><dd className="text-right">{MEETING_TYPES[info.meetingType as keyof typeof MEETING_TYPES]}</dd></div>
            )}
            {!reschedule && (
              <div className="flex justify-between gap-3"><dt className="font-semibold">Status</dt><dd className="text-right font-semibold text-gold-700">{confirmed ? "Confirmed" : "Awaiting confirmation"}</dd></div>
            )}
          </dl>
          {result?.textNote && <p className="mt-3 text-sm text-slate-600">{result.textNote}</p>}
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <a href={`/client/appointments${props.accountQuery}#upcoming`} className="inline-flex items-center justify-center gap-2 rounded-xl bg-navy-900 px-5 py-3 font-semibold text-white hover:bg-navy-800">
              <CalendarCheck2 className="size-5 text-gold-400" aria-hidden />View my appointments
            </a>
            <Link href={`/client${props.accountQuery}`} className="inline-flex items-center justify-center rounded-xl border-2 border-gold-500 px-5 py-3 font-semibold text-navy-900 hover:bg-gold-50">Back to Home</Link>
          </div>
          <p className="mt-5 text-xs text-slate-500">Need to change it? You can reschedule or cancel online up to the office&apos;s deadline, or call {props.officePhone}.</p>
        </section>
      </div>
    );
  }

  if (view === "info") {
    // A plain function (not a component), so inputs keep focus while typing.
    const row = (k: string, label: string, value: React.ReactNode, input: React.ReactNode) => (
      <div key={k} className="flex flex-col gap-1.5 border-b border-ivory-200 py-3 last:border-0 sm:flex-row sm:items-start sm:gap-4">
        <dt className="w-44 shrink-0 text-sm font-semibold text-navy-800">{label}</dt>
        <dd className="min-w-0 flex-1">
          {edit[k] || !onFile[k] ? (
            input
          ) : (
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 [overflow-wrap:anywhere]">{value || <span className="text-slate-500">Not on file</span>}</span>
              <button type="button" onClick={() => setEdit((e) => ({ ...e, [k]: true }))} className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4" data-testid={`change-${k}`}>
                <Pencil className="size-3.5" aria-hidden />Change
              </button>
            </div>
          )}
        </dd>
      </div>
    );
    const field = "w-full rounded-lg border border-ivory-200 bg-white px-3 py-2 text-navy-900 focus:border-gold-500";
    return (
      <div className="space-y-6" data-testid="booking-info">
        {header}
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <section className={card}>
            <h2 className={colTitle}><Num n={4} />Booking Information</h2>
            <p className="mt-1 text-sm text-slate-600">Please review the details we have on file. Use “Change” only if something is different for this appointment.</p>
            <dl className="mt-3">
              {row("legalName", "Full legal name", info.legalName, <input className={field} value={info.legalName} onChange={(e) => set("legalName", e.target.value)} autoComplete="name" aria-label="Full legal name" />)}
              {row("phone", "Mobile phone", info.phone, <input className={field} value={info.phone} onChange={(e) => set("phone", e.target.value)} inputMode="tel" autoComplete="tel" aria-label="Mobile phone" />)}
              {row("email", "Email", info.email, <input className={field} value={info.email} onChange={(e) => set("email", e.target.value)} type="email" autoComplete="email" aria-label="Email" />)}
              {row("clientKind", "Client status", info.clientKind === "EXISTING" ? "Existing client" : "New client", 
                  <div className="flex flex-wrap gap-4 text-sm">
                    {(["EXISTING", "NEW"] as const).map((v) => (
                      <label key={v} className="flex items-center gap-2"><input type="radio" name="clientKind" checked={info.clientKind === v} onChange={() => set("clientKind", v)} className="accent-[#C89D29]" />{v === "EXISTING" ? "Existing client" : "New client"}</label>
                    ))}
                  </div>
                )}
              {business && row("businessName", "Business name", info.businessName, <input className={field} value={info.businessName} onChange={(e) => set("businessName", e.target.value)} aria-label="Business name" />)}
              <div className="flex flex-col gap-1.5 border-b border-ivory-200 py-3 sm:flex-row sm:gap-4">
                <dt className="w-44 shrink-0 text-sm font-semibold text-navy-800">Services</dt>
                <dd className="min-w-0 flex-1">{selected.map((k) => serviceByKey(k)!.name).join(", ")}</dd>
              </div>
              <div className="flex flex-col gap-1.5 border-b border-ivory-200 py-3 sm:flex-row sm:gap-4">
                <dt className="w-44 shrink-0 text-sm font-semibold text-navy-800">Date &amp; time</dt>
                <dd className="flex min-w-0 flex-1 items-start justify-between gap-3">
                  <span>{date && dateLabel(date)} at {time && timeLabel(time)} CT · {totalTimeLabel(minutes)}</span>
                  <button type="button" onClick={() => setView("pick")} className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4"><Pencil className="size-3.5" aria-hidden />Change</button>
                </dd>
              </div>
              <div className="border-b border-ivory-200 py-3">
                <dt className="text-sm font-semibold text-navy-800">Appointment type</dt>
                <dd className="mt-2 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Appointment type">
                  {props.meetingTypes.map((m) => (
                    <button
                      type="button"
                      key={m}
                      role="radio"
                      aria-checked={info.meetingType === m}
                      onClick={() => set("meetingType", m)}
                      className={clsx("flex items-center justify-center gap-2 rounded-xl border-2 px-3 py-2.5 text-sm font-semibold", info.meetingType === m ? "border-gold-500 bg-gold-50 text-navy-900" : "border-ivory-200 text-navy-800 hover:border-gold-300")}
                      data-testid={`meeting-${m}`}
                    >
                      {info.meetingType === m && <Check className="size-4 text-gold-600" aria-hidden />}
                      {MEETING_TYPES[m as keyof typeof MEETING_TYPES]}
                    </button>
                  ))}
                </dd>
              </div>
              <div className="border-b border-ivory-200 py-3">
                <dt><label htmlFor="appt-reason" className="text-sm font-semibold text-navy-800">Brief reason for the appointment</label></dt>
                <dd className="mt-2">
                  <textarea id="appt-reason" className={field} rows={3} maxLength={500} value={info.reason} onChange={(e) => set("reason", e.target.value)} placeholder="For example: review my 2026 return, set up payroll for two employees…" data-testid="appt-reason" />
                  <p className="mt-1 text-xs text-slate-500">Please don&apos;t include Social Security or account numbers.</p>
                </dd>
              </div>
              <div className="py-3">
                <label className="flex items-start gap-3 text-sm">
                  <input type="checkbox" className="mt-1 size-4 shrink-0 accent-[#C89D29]" checked={info.smsConsent} onChange={(e) => set("smsConsent", e.target.checked)} data-testid="sms-consent" />
                  <span>
                    <span className="font-semibold text-navy-900">Text me about this appointment</span> (confirmations, reminders and changes).
                    <span className="mt-1 block text-xs text-slate-600">{props.smsConsentText} Consent is not a condition of service. Appointment texts are separate from marketing messages.</span>
                  </span>
                </label>
              </div>
            </dl>
          </section>
          <div className="space-y-4">
            {summary}
            {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-800">{error}</p>}
            <button type="button" className={goldBtn} disabled={props.readOnly || pending || !info.meetingType || info.reason.trim().length < 3 || (business && !info.businessName.trim())} onClick={submitBooking} data-testid="confirm-book">
              {pending ? "Booking…" : <>Confirm &amp; Book <ArrowRight className="size-5" aria-hidden /></>}
            </button>
            {props.readOnly && <p className="text-center text-xs font-semibold text-gold-300" data-testid="preview-off">Turned off in View as Client</p>}
            {props.requireApproval && <p className="text-center text-xs text-navy-100">Your time is held as soon as you book. Our office confirms each appointment.</p>}
            <button type="button" onClick={() => setView("pick")} className="inline-flex w-full items-center justify-center gap-2 text-sm font-semibold text-gold-300 hover:text-gold-200"><ArrowLeft className="size-4" aria-hidden />Back to date &amp; time</button>
          </div>
        </div>
      </div>
    );
  }

  // --- Steps 1–3 ------------------------------------------------------------
  const [ty, tm] = props.today.split("-").map(Number);
  const atFirstMonth = ym.y * 12 + ym.m <= ty * 12 + tm;
  const first = new Date(Date.UTC(ym.y, ym.m - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(ym.y, ym.m, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array(first).fill(null), ...Array.from({ length: count }, (_, i) => `${ym.y}-${String(ym.m).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`)];

  return (
    <div className="space-y-6" data-testid="booking-wizard">
      {header}
      {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-800">{error}</p>}
      <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
        {/* 1. Services */}
        <section className={card} data-testid="col-services">
          <h2 className={colTitle}><Num n={1} />Select Your Service(s)</h2>
          <p className="mt-1 text-[13px] text-slate-600">
            {reschedule ? "Your services stay the same when you reschedule." : "Choose one or more services. Your appointment will be scheduled for the longest service selected (maximum of 2 hours)."}
          </p>
          <ul className="mt-3 space-y-2">
            {APPOINTMENT_SERVICES.map((s) => {
              const on = selected.includes(s.key);
              const Icon = ICONS[s.icon];
              return (
                <li key={s.key}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    disabled={!!reschedule && !on}
                    onClick={() => toggle(s.key)}
                    className={clsx(
                      "flex w-full items-center gap-3 rounded-xl border-2 px-3 py-2.5 text-left transition",
                      on ? "border-gold-500 bg-gold-50/70 shadow-[0_6px_16px_-10px_rgb(200_157_41/0.9)]" : "border-ivory-200 bg-white hover:border-gold-300",
                      reschedule && !on && "opacity-40",
                    )}
                    data-testid={`service-${s.key}`}
                  >
                    <Icon className="size-7 shrink-0 text-gold-600" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-bold leading-snug text-navy-900">{s.name}</span>
                      <span className="block text-xs leading-snug text-slate-600">{s.description}</span>
                    </span>
                    <span className="shrink-0 text-xs font-semibold text-navy-800">{durationLabel(s.minutes)}</span>
                    <span className={clsx("flex size-6 shrink-0 items-center justify-center rounded-md border-2", on ? "border-gold-500 bg-gold-500 text-navy-950" : "border-slate-300 bg-white")}>
                      {on && <Check className="size-4" aria-hidden />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {/* 2. Date */}
        <div className="min-w-0 space-y-4">
          <section className={card} data-testid="col-date">
            <h2 className={colTitle}><Num n={2} />Choose a Date</h2>
            <div className="mt-3 flex items-center justify-between">
              <button type="button" onClick={() => goMonth(-1)} disabled={atFirstMonth || pending} className="rounded-full p-2 text-navy-900 hover:bg-gold-50 disabled:opacity-30" aria-label="Previous month"><ChevronLeft className="size-5" /></button>
              <p className="font-serif text-lg font-bold" data-testid="month-label">{monthName(ym.y, ym.m)}</p>
              <button type="button" onClick={() => goMonth(1)} disabled={pending} className="rounded-full p-2 text-navy-900 hover:bg-gold-50 disabled:opacity-30" aria-label="Next month"><ChevronRight className="size-5" /></button>
            </div>
            <div className="mt-2 grid grid-cols-7 gap-1 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <span key={d}>{d}</span>)}
            </div>
            <div className={clsx("mt-1 grid grid-cols-7 gap-1", pending && "opacity-60")} data-testid="calendar-grid">
              {cells.map((d, i) => {
                if (!d) return <span key={`b${i}`} />;
                const open = openDays.has(d);
                const picked = d === date;
                return (
                  <button
                    key={d}
                    type="button"
                    disabled={!open}
                    onClick={() => {
                      setDate(d);
                      setTime(null);
                    }}
                    aria-pressed={picked}
                    aria-label={`${dateLabel(d, { weekday: "long", month: "long", day: "numeric" })}${open ? ", available" : ", unavailable"}`}
                    className={clsx(
                      "relative flex aspect-square min-h-9 flex-col items-center justify-center rounded-full text-sm font-semibold transition",
                      picked ? "bg-gradient-to-b from-gold-300 to-gold-500 text-navy-950 shadow-md" : open ? "text-navy-900 hover:bg-gold-50" : "cursor-not-allowed text-slate-300",
                    )}
                    data-testid={open ? "day-open" : "day-closed"}
                    data-date={d}
                  >
                    {Number(d.slice(8))}
                    {open && !picked && <span className="absolute bottom-1 size-1.5 rounded-full bg-gold-500" aria-hidden />}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex items-center justify-center gap-5 text-xs text-slate-600">
              <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-gold-500" aria-hidden />Available</span>
              <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-slate-300" aria-hidden />Unavailable</span>
            </div>
            {current && !current.published && <p className="mt-3 rounded-lg bg-ivory-100 px-3 py-2 text-center text-sm text-navy-800" data-testid="month-unpublished">This month isn&apos;t open for booking yet. Please check another month.</p>}
            {current?.published && !openDays.size && minutes > 0 && <p className="mt-3 rounded-lg bg-ivory-100 px-3 py-2 text-center text-sm text-navy-800">No open times this month for a {totalTimeLabel(minutes).replace(" (maximum)", "")} appointment.</p>}
            {!minutes && <p className="mt-3 text-center text-sm text-slate-600">Select a service to see available dates.</p>}
          </section>
          <div className="flex items-start gap-3 rounded-2xl border border-gold-500/40 bg-navy-900/70 px-4 py-3 text-sm text-navy-100">
            <Info className="mt-0.5 size-5 shrink-0 text-gold-400" aria-hidden />
            <p><span className="font-semibold text-white">Availability is updated monthly.</span> Only published dates and times are available for booking.</p>
          </div>
        </div>

        {/* 3. Time + summary */}
        <div className="min-w-0 space-y-4 lg:col-span-2 xl:col-span-1">
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-1">
            <section className={card} data-testid="col-time">
              <h2 className={colTitle}><Num n={3} />Choose a Time</h2>
              <p className="mt-1 text-sm text-slate-600">{date ? <>Available times for <strong className="text-navy-900">{dateLabel(date)}</strong></> : "Choose a date to see open times."}</p>
              <p className="text-xs text-slate-500">All times are Central Time (CT).</p>
              <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-1">
                {times.map((t) => {
                  const on = t === time;
                  return (
                    <li key={t}>
                      <button
                        type="button"
                        onClick={() => setTime(t)}
                        aria-pressed={on}
                        className={clsx(
                          "flex w-full items-center justify-center gap-2 rounded-xl border-2 px-3 py-2.5 text-[15px] font-semibold transition",
                          on ? "border-gold-500 bg-gradient-to-b from-gold-300 to-gold-500 text-navy-950" : "border-gold-500/70 bg-white text-navy-900 hover:bg-gold-50",
                        )}
                        data-testid="time-option"
                      >
                        {on ? <Check className="size-4" aria-hidden /> : <Clock className="size-4 text-gold-600" aria-hidden />}
                        {timeLabel(t)}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {date && !times.length && <p className="mt-3 text-sm text-slate-600">No open times left on this date.</p>}
            </section>
            <div className="space-y-4">
              {summary}
              <button type="button" className={goldBtn} disabled={!selected.length || !date || !time || pending} onClick={continueToInfo} data-testid="book-appointment">
                {pending && reschedule ? "Saving…" : reschedule ? <>Request New Time <ArrowRight className="size-5" aria-hidden /></> : <>Book Appointment <ArrowRight className="size-5" aria-hidden /></>}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="lg:hidden"><DecorPanel /></div>
    </div>
  );
}
