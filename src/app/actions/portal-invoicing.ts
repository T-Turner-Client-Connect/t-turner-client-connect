"use server";

import { revalidatePath } from "next/cache";
import { requirePortalUser } from "@/lib/portal/session";
import { run, str, type ActionState } from "@/lib/action";
import { requestCustomerInvoice } from "@/lib/services/portal-client-invoicing";

/** Client Invoicing — "Request an invoice": a message to the office; staff create the invoice. */
export async function requestCustomerInvoiceAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const customer = str(fd, "customerId");
    await requestCustomerInvoice(user, {
      clientId,
      customerId: customer && customer !== "NEW" ? customer : null,
      customerName: str(fd, "customerName"),
      amount: str(fd, "amount"),
      description: str(fd, "description"),
      dueDate: str(fd, "dueDate"),
      idempotencyKey: str(fd, "idempotencyKey") || null,
    });
    revalidatePath("/client/invoicing");
    revalidatePath("/client/messages");
    return "Request sent. Our office will create the invoice and let you know here in your portal.";
  });
}
