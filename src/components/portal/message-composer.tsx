"use client";

import { useState } from "react";
import { Laptop, Mail, Paperclip, Send, Smartphone } from "lucide-react";
import { ActionForm } from "@/components/action-form";

type State = { error?: string; ok?: string; at?: number } | null;

export const SUBJECTS = ["General question", "Tax preparation", "Documents I sent", "Billing & payments", "Appointment request", "Bookkeeping", "Other"];

/**
 * "Send a Message" from the approved Message Center design. A portal message goes through the
 * existing secure messaging. Text and Email open the device's own texting or email app,
 * addressed to the office — nothing is sent by this page for those two.
 */
export function MessageComposer({
  action,
  canUpload,
  textNumber,
  email,
  defaultSubject,
  uploadLabel,
}: {
  action: (prev: State, fd: FormData) => Promise<State>;
  canUpload: boolean;
  textNumber: { display: string; tel: string } | null;
  email: string;
  defaultSubject?: string;
  uploadLabel: string;
}) {
  const [mode, setMode] = useState<"portal" | "text" | "email">("portal");
  const [subject, setSubject] = useState(defaultSubject ?? "");
  const [body, setBody] = useState("");
  const options = [
    { key: "portal" as const, icon: Laptop, title: "Message in Portal", sub: "(Secure)" },
    ...(textNumber ? [{ key: "text" as const, icon: Smartphone, title: "Text Message", sub: `(${textNumber.display})` }] : []),
    { key: "email" as const, icon: Mail, title: "Email", sub: `(${email})` },
  ];
  const external = mode === "text" ? `sms:${textNumber?.tel}?&body=${encodeURIComponent(`${subject ? `${subject}: ` : ""}${body}`)}` : `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  const fields = (
    <>
      <label className="block">
        <span className="mb-1.5 block font-semibold text-navy-900">Subject <span className="text-red-700">*</span></span>
        <select className="input h-12" name="subject" required value={subject} onChange={(e) => setSubject(e.target.value)}>
          <option value="">Choose a subject…</option>
          {SUBJECTS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="mb-1.5 block font-semibold text-navy-900">Message <span className="text-red-700">*</span></span>
        <textarea className="input min-h-32" name="body" required maxLength={2000} placeholder="Type your message here…" value={body} onChange={(e) => setBody(e.target.value)} />
        <span className="mt-1 block text-right text-sm text-slate-500">{body.length} / 2,000</span>
      </label>
    </>
  );

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="mb-2 font-semibold text-navy-900">How would you like to communicate?</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {options.map((o) => (
            <label key={o.key} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 ${mode === o.key ? "border-gold-500 bg-gold-50 ring-1 ring-gold-400" : "border-ivory-200 bg-white hover:border-gold-300"}`}>
              <o.icon className="size-7 shrink-0 text-navy-900" aria-hidden />
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block font-semibold text-navy-900">{o.title}</span>
                <span className="block break-all text-sm text-slate-600">{o.sub}</span>
              </span>
              <input type="radio" name="mode" value={o.key} checked={mode === o.key} onChange={() => setMode(o.key)} className="size-5 accent-gold-600" />
            </label>
          ))}
        </div>
      </fieldset>

      {mode === "portal" ? (
        <ActionForm action={action} className="space-y-5" resetOnSuccess idempotent>
          {fields}
          {canUpload && (
            <label className="block">
              <span className="mb-1.5 block font-semibold text-navy-900">Attach a file (optional)</span>
              <span className="flex items-center gap-3 rounded-lg border border-ivory-300 bg-white px-3 py-2">
                <Paperclip className="size-5 shrink-0 text-slate-500" aria-hidden />
                <input type="file" name="file" accept="application/pdf,image/png,image/jpeg" className="min-w-0 flex-1 text-sm" />
              </span>
              <span className="mt-2 block text-sm text-slate-600">PDF, JPG, or PNG up to {uploadLabel}.</span>
            </label>
          )}
          <button type="submit" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-navy-900 to-navy-950 px-7 py-3 text-lg font-semibold text-white shadow hover:to-navy-900" data-testid="send-message">
            <Send className="size-5" aria-hidden /> Send Message
          </button>
        </ActionForm>
      ) : (
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            window.location.href = external;
          }}
        >
          {fields}
          <p className="text-sm text-slate-600">{mode === "text" ? "This opens your phone's texting app, addressed to our office." : "This opens your email app, addressed to our office."} For documents or account details, please use a secure portal message instead.</p>
          <button type="submit" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-navy-900 to-navy-950 px-7 py-3 text-lg font-semibold text-white shadow hover:to-navy-900">
            <Send className="size-5" aria-hidden /> {mode === "text" ? "Open Text Message" : "Open Email"}
          </button>
        </form>
      )}
    </div>
  );
}
