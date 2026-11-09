import { BellRing, Mail, MessageSquareText, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import { Button, Card } from "@/components/ui";
import { portalCommPrefsAction } from "@/app/actions/portal";
import { previewFormAction } from "@/app/actions/preview";
import { PreviewDisabled } from "@/components/portal/preview-off";
import { SMS_CONSENT_TEXT } from "@/lib/business";
import { formatPhone } from "@/lib/normalize";
import type { PreferenceState } from "@/lib/services/comm-prefs";

function Toggle({ name, label, description, checked, disabled, icon, children }: { name: string; label: string; description: string; checked: boolean; disabled?: boolean; icon: ReactNode; children?: ReactNode }) {
  return (
    <div className="py-4 first:pt-0">
      <label className="flex cursor-pointer items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-navy-50 text-navy-900" aria-hidden>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-navy-900">{label}</span>
          <span className="mt-0.5 block text-sm text-slate-600">{description}</span>
        </span>
        <input type="checkbox" role="switch" name={name} defaultChecked={checked} disabled={disabled} className="peer sr-only" data-testid={`pref-${name}`} />
        <span
          aria-hidden
          className="relative mt-1 inline-flex h-6 w-11 shrink-0 rounded-full bg-slate-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:bg-navy-900 peer-checked:after:translate-x-5 peer-focus-visible:ring-2 peer-focus-visible:ring-gold-500 peer-focus-visible:ring-offset-2 peer-disabled:opacity-50"
        />
      </label>
      {children && <div className="mt-2 pl-12">{children}</div>}
    </div>
  );
}

/** Portal Account → Communication Preferences: three choices, each saved separately to the client's profile. */
/** `readOnly` (View as Client): the same choices, disabled, posting only to the preview stand-in. */
export function CommPrefsCard({ prefs, readOnly }: { prefs: PreferenceState; readOnly?: boolean }) {
  const phone = prefs.phones[0];
  return (
    <Card title="Communication Preferences" className="border-t-4 border-t-gold-500">
      <p className="mb-4 text-sm text-slate-600">Choose which optional messages you&apos;d like from us. You can change these anytime, and changes take effect right away.</p>
      <PreviewDisabled readOnly={readOnly}>
      <ActionForm action={readOnly ? previewFormAction : portalCommPrefsAction}>
        <div className="divide-y divide-ivory-200">
          <Toggle
            name="promoSms"
            label="Promotional text messages"
            description="Marketing texts, special offers and announcements."
            checked={prefs.promoSms}
            disabled={prefs.smsBlocked}
            icon={<MessageSquareText className="size-5" />}
          >
            {prefs.smsBlocked ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status" data-testid="sms-blocked">
                Texts are blocked because you replied STOP. Reply <strong>START</strong> to any text from us to resume. Until then, we&apos;ll reach you by email and in your portal.
              </p>
            ) : phone ? (
              <p className="text-xs text-slate-500">Sent to {formatPhone(phone)}. By turning this on: {SMS_CONSENT_TEXT.MARKETING}</p>
            ) : (
              <p className="text-xs text-slate-500">Add your mobile number under Notifications below to receive texts.</p>
            )}
          </Toggle>
          <Toggle
            name="promoEmail"
            label="Promotional emails"
            description="Email flyers, newsletters and promotional updates."
            checked={prefs.promoEmail}
            icon={<Mail className="size-5" />}
          >
            {prefs.emailBlocked && <p className="text-xs text-amber-800">We can&apos;t email {prefs.emails[0]} right now ({prefs.emailBlocked.toLowerCase()}). Please call our office.</p>}
          </Toggle>
          <Toggle
            name="generalUpdates"
            label="General business updates"
            description="Nonessential announcements and informational news, like office hours and holiday closures."
            checked={prefs.generalUpdates}
            icon={<BellRing className="size-5" />}
          />
        </div>
        <div className="mt-2 flex gap-3 rounded-xl border border-navy-100 bg-navy-50 p-4 text-sm text-navy-900">
          <ShieldCheck className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p>
            <strong>You&apos;ll still receive essential service messages</strong> — appointment confirmations, billing notices, account security codes and important tax document requests —
            by email and in your portal, and by text when you&apos;ve agreed to service texts.
          </p>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button type="submit" variant="gold" className="min-h-11 px-6 text-[15px]" data-testid="save-preferences">Save Preferences</Button>
          <span className="text-xs text-slate-500">You can also unsubscribe from any promotional email with its link, or reply STOP to a text.</span>
        </div>
      </ActionForm>
      </PreviewDisabled>
    </Card>
  );
}
