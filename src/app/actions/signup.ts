"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { ClientType } from "@prisma/client";
import { run, str, type ActionState } from "@/lib/action";
import { clientIp, requireUser } from "@/lib/auth/session";
import { createPortalSession, markPortalMfaPassed, requirePortalUser } from "@/lib/portal/session";
import { ValidationError } from "@/lib/services/clients";
import {
  approveAsNewClient,
  completeSignup,
  declineApplication,
  dismissActivation,
  linkToExistingClient,
  requestActivation,
  resendSignupCode,
  saveOnboardingDetails,
  staffSendActivation,
  startSignup,
  submitOnboarding,
  uploadOnboardingFile,
} from "@/lib/services/client-signup";

const SECURE = process.env.NODE_ENV === "production";
const SIGNUP_COOKIE_NAME = SECURE ? "__Host-tcc_signup" : "tcc_signup";

export async function startSignupAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let token = "";
  const result = await run(async () => {
    ({ token } = await startSignup({
      name: str(fd, "name"),
      email: str(fd, "email"),
      password: str(fd, "password"),
      confirm: str(fd, "confirm"),
      ip: await clientIp(),
      honeypot: str(fd, "company_website"),
    }));
  });
  if (!result?.ok) return result;
  (await cookies()).set(SIGNUP_COOKIE_NAME, token, { httpOnly: true, secure: SECURE, sameSite: "lax", path: "/", maxAge: 60 * 60 });
  redirect("/client/signup/verify");
}

export async function resendSignupAction(_prev: ActionState): Promise<ActionState> {
  return run(async () => {
    const masked = await resendSignupCode((await cookies()).get(SIGNUP_COOKIE_NAME)?.value);
    return `We emailed a new code to ${masked}.`;
  });
}

export async function completeSignupAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const jar = await cookies();
  let userId = "";
  const result = await run(async () => {
    userId = (await completeSignup(jar.get(SIGNUP_COOKIE_NAME)?.value, str(fd, "code"))).id;
  });
  if (!result?.ok) return result;
  jar.delete(SIGNUP_COOKIE_NAME);
  // Password + the emailed code (which also verified the address) = signed in.
  const sessionId = await createPortalSession(userId);
  await markPortalMfaPassed(sessionId);
  redirect("/client/start");
}

export async function saveOnboardingAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const type = str(fd, "clientType");
    const clientType: ClientType = type === "BUSINESS" || type === "NONPROFIT" ? type : "INDIVIDUAL";
    await saveOnboardingDetails(user, {
      clientType,
      firstName: str(fd, "firstName"),
      lastName: str(fd, "lastName"),
      businessName: str(fd, "businessName"),
      phone: str(fd, "phone"),
      addressLine1: str(fd, "addressLine1"),
      city: str(fd, "city"),
      state: str(fd, "state"),
      postalCode: str(fd, "postalCode"),
      services: fd.getAll("services").map(String),
      notes: str(fd, "notes"),
      smsService: fd.get("smsService") === "on",
      smsMarketing: fd.get("smsMarketing") === "on",
      emailMarketing: fd.get("emailMarketing") === "on",
    });
    revalidatePath("/client/start");
    return "Saved.";
  });
}

export async function uploadOnboardingAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const f = fd.get("file");
    if (!(f instanceof File) || f.size === 0) throw new ValidationError("Choose a file to upload.");
    await uploadOnboardingFile(user, { bytes: new Uint8Array(await f.arrayBuffer()), originalName: f.name });
    revalidatePath("/client/start");
    return "Uploaded securely.";
  });
}

export async function submitOnboardingAction(_prev: ActionState): Promise<ActionState> {
  const user = await requirePortalUser();
  let outcome = "";
  const result = await run(async () => {
    outcome = await submitOnboarding(user);
  });
  if (!result?.ok) return result;
  if (outcome === "APPROVED_NEW") redirect("/client?welcome=1");
  revalidatePath("/client/start");
  return { ok: "Thank you! Our team will finish setting up your account and email you.", at: Date.now() };
}

export async function requestActivationAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    await requestActivation({ email: str(fd, "email"), name: str(fd, "name"), phone: str(fd, "phone"), ip: await clientIp(), honeypot: str(fd, "company_website") });
    // Same answer whatever happened, so nobody learns whether an email is on file.
    return "Thank you. If we can match your request to your client record, we'll email a secure activation link to the address we have on file. Otherwise our office will contact you to verify your identity. Please allow one business day.";
  });
}

// --- Staff review -----------------------------------------------------------

export async function reviewStepAction(applicationId: string, step: "new" | "link" | "decline", _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (step === "new") await approveAsNewClient(actor, applicationId);
    if (step === "link") await linkToExistingClient(actor, applicationId, str(fd, "clientId"), fd.get("identityVerified") === "on");
    if (step === "decline") await declineApplication(actor, applicationId, str(fd, "note"));
    revalidatePath("/clients/onboarding");
    return { new: "New client record created and connected.", link: "Login connected to the existing client record.", decline: "Declined." }[step];
  });
}

export async function activationStepAction(requestId: string, step: "send" | "dismiss", _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (step === "send") await staffSendActivation(actor, requestId, str(fd, "clientId"));
    else await dismissActivation(actor, requestId);
    revalidatePath("/clients/onboarding");
    return step === "send" ? "Activation link emailed to the address on file." : "Dismissed.";
  });
}
