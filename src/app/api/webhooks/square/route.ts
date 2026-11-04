import { handleSquareWebhook } from "@/lib/services/square-invoicing";

// Square webhooks for invoices sent through Square: invoice.payment_made, invoice.updated,
// invoice.canceled and payment.updated. Signed with SQUARE_WEBHOOK_SIGNATURE_KEY over the
// notification URL + raw body; each event_id is applied once.
export async function POST(req: Request) {
  const body = await req.text();
  const r = await handleSquareWebhook(body, req.headers.get("x-square-hmacsha256-signature"));
  return new Response(r.body, { status: r.status });
}
