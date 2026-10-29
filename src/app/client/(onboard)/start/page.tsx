import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { saveOnboardingAction, submitOnboardingAction, uploadOnboardingAction } from "@/app/actions/signup";
import { requirePortalUser } from "@/lib/portal/session";
import { accessibleClients } from "@/lib/portal/access";
import { myApplication, SERVICES } from "@/lib/services/client-signup";
import { BUSINESS, SMS_CONSENT_TEXT } from "@/lib/business";
import { formatBytes } from "@/lib/files";

export const metadata = { title: "Set up your account" };

export default async function StartPage() {
  const user = await requirePortalUser();
  if ((await accessibleClients(user.id)).length) redirect("/client");
  const app = await myApplication(user);
  if (!app || app.status === "DECLINED") {
    return (
      <>
        <PageHeader title="Your portal" />
        <Notice>Your login isn&apos;t connected to a client account yet. Please call our office at {BUSINESS.officePhoneDisplay} and we&apos;ll help.</Notice>
      </>
    );
  }
  if (app.status !== "IN_PROGRESS") {
    return (
      <>
        <PageHeader title="Thank you!" />
        <Notice title="Our team is finishing your setup">
          We received your details{app.files.length ? ` and ${app.files.length} document(s)` : ""}. A team member will finish connecting your account and email you — usually within one business day.
          Questions? Call {BUSINESS.officePhoneDisplay}.
        </Notice>
      </>
    );
  }
  const done = { details: app.servicesRequested.length > 0, docs: app.files.length > 0 };
  return (
    <>
      <PageHeader title={`Welcome, ${user.name.split(" ")[0]}`} subtitle="A few quick steps to set up your client account." />
      <ol className="mb-5 grid gap-2 text-sm sm:grid-cols-4">
        <li className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">✓ Email verified</li>
        <li className={`rounded-lg px-3 py-2 ${done.details ? "bg-emerald-50 text-emerald-900" : "bg-white"}`}>{done.details ? "✓" : "2."} Your details &amp; services</li>
        <li className={`rounded-lg px-3 py-2 ${done.docs ? "bg-emerald-50 text-emerald-900" : "bg-white"}`}>{done.docs ? "✓" : "3."} Documents (optional)</li>
        <li className="rounded-lg bg-white px-3 py-2">4. Submit</li>
      </ol>
      <div className="space-y-4">
        <Card title="Your details and the services you need">
          <ActionForm action={saveOnboardingAction} className="grid gap-3 sm:grid-cols-2">
            <Field label="I'm setting up an account for" className="sm:col-span-2">
              <select className="input" name="clientType" defaultValue={app.clientType}>
                <option value="INDIVIDUAL">Myself / my household</option><option value="BUSINESS">A business</option><option value="NONPROFIT">A nonprofit</option>
              </select>
            </Field>
            <Field label="First name"><input className="input" name="firstName" defaultValue={app.firstName ?? ""} autoComplete="given-name" /></Field>
            <Field label="Last name"><input className="input" name="lastName" defaultValue={app.lastName ?? ""} autoComplete="family-name" /></Field>
            <Field label="Business or organization name (if any)" className="sm:col-span-2"><input className="input" name="businessName" defaultValue={app.businessName ?? ""} autoComplete="organization" /></Field>
            <Field label="Mobile phone"><input className="input" type="tel" name="phone" defaultValue={app.phone ?? ""} autoComplete="tel" /></Field>
            <Field label="Street address"><input className="input" name="addressLine1" defaultValue={app.addressLine1 ?? ""} autoComplete="street-address" /></Field>
            <Field label="City"><input className="input" name="city" defaultValue={app.city ?? ""} autoComplete="address-level2" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="State"><input className="input" name="state" maxLength={2} defaultValue={app.state ?? ""} autoComplete="address-level1" /></Field>
              <Field label="ZIP"><input className="input" name="postalCode" defaultValue={app.postalCode ?? ""} autoComplete="postal-code" /></Field>
            </div>
            <fieldset className="sm:col-span-2">
              <legend className="mb-1 text-sm font-semibold text-navy-900">Services you&apos;re interested in</legend>
              <div className="grid gap-1 sm:grid-cols-2">
                {SERVICES.map((s) => <label key={s} className="flex items-center gap-2 text-sm"><input type="checkbox" name="services" value={s} defaultChecked={app.servicesRequested.includes(s)} /> {s}</label>)}
              </div>
            </fieldset>
            <Field label="Anything we should know? (optional — please don't include Social Security numbers)" className="sm:col-span-2"><textarea className="input" name="notes" rows={3} defaultValue={app.notes ?? ""} /></Field>
            <fieldset className="space-y-2 rounded-lg bg-ivory p-3 text-sm sm:col-span-2">
              <legend className="font-semibold text-navy-900">Optional communication choices</legend>
              <p className="text-xs text-slate-600">Each is optional and separate. You can still use all of our services without them. You&apos;ll always get important portal notices by email.</p>
              <label className="flex items-start gap-2"><input type="checkbox" name="smsService" defaultChecked={app.smsService} className="mt-1" /><span>{SMS_CONSENT_TEXT.SERVICE}</span></label>
              <label className="flex items-start gap-2"><input type="checkbox" name="smsMarketing" defaultChecked={app.smsMarketing} className="mt-1" /><span>{SMS_CONSENT_TEXT.MARKETING}</span></label>
              <label className="flex items-start gap-2"><input type="checkbox" name="emailMarketing" defaultChecked={app.emailMarketing} className="mt-1" /><span>Send me occasional email newsletters, tips and offers. I can unsubscribe anytime.</span></label>
            </fieldset>
            <div className="sm:col-span-2"><Button type="submit">Save details</Button></div>
          </ActionForm>
        </Card>
        <Card title="Upload documents (optional)">
          <p className="mb-2 text-sm text-slate-600">Prior-year returns, notices, or business documents you already have. PDF, JPG or PNG up to 5 MB each. They stay private until your account is set up.</p>
          {app.files.length > 0 && (
            <ul className="mb-3 space-y-1 text-sm" data-testid="onboarding-files">
              {app.files.map((f) => <li key={f.id}>📄 {f.originalName} <span className="text-slate-500">({formatBytes(f.sizeBytes)})</span></li>)}
            </ul>
          )}
          <ActionForm action={uploadOnboardingAction} className="flex flex-wrap items-end gap-2" resetOnSuccess>
            <input className="input flex-1" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required aria-label="Document to upload" />
            <Button type="submit" variant="secondary">Upload</Button>
          </ActionForm>
        </Card>
        <Card title="Submit">
          {!done.details && <p className="mb-2 text-sm text-slate-600">Save your details first.</p>}
          <ActionForm action={submitOnboardingAction}>
            <Button type="submit" disabled={!done.details}>Submit and finish setup</Button>
          </ActionForm>
          <p className="mt-2 text-xs text-slate-600">Submitting doesn&apos;t start any paid service. We&apos;ll review your request and contact you. {done.details && <Badge tone="green">Ready</Badge>}</p>
        </Card>
      </div>
    </>
  );
}
