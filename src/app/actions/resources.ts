"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { requirePortalUser } from "@/lib/portal/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { REQUEST_TOPICS, type RequestTopic } from "@/lib/resources/catalog";
import { checkResourceLinks, moveResource, requestResourceHelp, saveFaq, saveResource, setFaqHidden, setPreferredState, setResourceHidden } from "@/lib/services/resources";

export async function setStateAction(state: string) {
  const user = await requirePortalUser();
  await setPreferredState(user, state);
}

export async function resourceHelpAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const topic = str(fd, "topic") as RequestTopic;
    if (!(topic in REQUEST_TOPICS)) throw new ValidationError("Choose what you need help with.");
    const f = fd.get("file");
    const file = f instanceof File && f.size > 0 ? { bytes: new Uint8Array(await f.arrayBuffer()), originalName: f.name } : null;
    const y = str(fd, "year");
    await requestResourceHelp(user, {
      clientId,
      topic,
      state: str(fd, "state"),
      area: str(fd, "area") || null,
      message: str(fd, "message"),
      file,
      year: y === "unsure" ? "unsure" : y ? Number(y) : null,
    });
    revalidatePath("/client/messages");
    return "Sent securely to our office. We'll reply in your portal Messages.";
  });
}

export async function saveResourceAction(id: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await saveResource(
      actor,
      {
        jurisdiction: str(fd, "jurisdiction"),
        county: str(fd, "county"),
        city: str(fd, "city"),
        category: str(fd, "category"),
        title: str(fd, "title"),
        purpose: str(fd, "purpose"),
        agency: str(fd, "agency"),
        url: str(fd, "url"),
        phone: str(fd, "phone"),
        status: str(fd, "status"),
        notes: str(fd, "notes"),
      },
      id ?? undefined,
    );
    revalidatePath("/resources");
    return "Saved.";
  });
}

export async function resourceStepAction(id: string, step: "hide" | "show" | "up" | "down", _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (step === "hide" || step === "show") await setResourceHidden(actor, id, step === "hide");
    else await moveResource(actor, id, step);
    revalidatePath("/resources");
    return step === "hide" ? "Hidden from clients." : step === "show" ? "Visible to clients." : "Moved.";
  });
}

export async function saveFaqAction(id: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await saveFaq(actor, { question: str(fd, "question"), answer: str(fd, "answer"), tags: str(fd, "tags").split(",") }, id ?? undefined);
    revalidatePath("/resources");
    return "FAQ saved.";
  });
}

export async function faqStepAction(id: string, hidden: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setFaqHidden(actor, id, hidden);
    revalidatePath("/resources");
    return hidden ? "Hidden." : "Shown.";
  });
}

export async function checkLinksAction(_prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (actor.role !== "ADMIN") throw new ValidationError("Only an Admin can run the link check.");
    const r = await checkResourceLinks(60, 0);
    revalidatePath("/resources");
    return `Checked ${r.checked} links: ${r.ok} reachable, ${r.failed} need attention.`;
  });
}
