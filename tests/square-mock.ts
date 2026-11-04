import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local, stateful stand-in for the parts of Square's API that invoicing uses (fictional data
 * only). Tests point SQUARE_API_BASE at it, so nothing ever reaches Square. It honours
 * idempotency keys the way Square does (same key → same object, no second create) and logs
 * every call so tests can count creates. It also accepts emails at /resend/emails.
 */
type Money = { amount: number; currency: string };
export type MockCustomer = { id: string; email_address?: string; phone_number?: string; given_name?: string; family_name?: string; company_name?: string; reference_id?: string; created_at: string };
export type MockInvoice = {
  id: string;
  version: number;
  status: string;
  order_id: string;
  location_id: string;
  invoice_number?: string;
  delivery_method?: string;
  public_url?: string;
  primary_recipient: { customer_id: string };
  accepted_payment_methods?: Record<string, boolean>;
  payment_requests: { uid: string; request_type: string; due_date: string; computed_amount_money: Money; total_completed_amount_money: Money }[];
};
export type MockPayment = { id: string; status: string; amount_money: Money; source_type: string; created_at: string; order_id?: string; customer_id?: string };

export class SquareMock {
  server!: http.Server;
  base = "";
  calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  customers: MockCustomer[] = [];
  orders = new Map<string, { id: string; customer_id?: string; total: number; line_items: unknown[]; discounts?: unknown[]; tenders: { payment_id: string }[] }>();
  invoices = new Map<string, MockInvoice>();
  payments = new Map<string, MockPayment>();
  emails: { to: string[]; subject: string; text: string; html?: string; idempotencyKey?: string }[] = [];
  private keys = new Map<string, unknown>();
  private seq = 0;
  /** Paths whose next response is dropped after the work is done (a lost reply). */
  dropOnce = new Set<string>();
  /** Answer every request with this HTTP status (e.g. 503) until cleared. */
  failAll: number | null = null;
  scopes: string[] | null = null;
  token = "fictional-token";

  async start(port = 0) {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(port, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
  reset() {
    this.calls = [];
    this.customers = [];
    this.orders.clear();
    this.invoices.clear();
    this.payments.clear();
    this.emails = [];
    this.keys.clear();
    this.dropOnce.clear();
    this.failAll = null;
    this.scopes = null;
  }
  id(prefix: string) {
    return `${prefix}${String(++this.seq).padStart(6, "0")}FICT`;
  }
  count(method: string, path: string) {
    return this.calls.filter((c) => c.method === method && c.path === path).length;
  }
  /** Square-side calls only (not the email endpoint). */
  squareCalls() {
    return this.calls.filter((c) => c.path.startsWith("/v2/") || c.path.startsWith("/oauth2/"));
  }

  /** The client pays (part of) a published invoice in Square. Returns the completed payment. */
  pay(invoiceId: string, amount: number, sourceType = "CARD", at = new Date()): MockPayment {
    const inv = this.invoices.get(invoiceId)!;
    const order = this.orders.get(inv.order_id)!;
    const p: MockPayment = { id: this.id("PAY"), status: "COMPLETED", amount_money: { amount, currency: "USD" }, source_type: sourceType, created_at: at.toISOString(), order_id: order.id, customer_id: inv.primary_recipient.customer_id };
    this.payments.set(p.id, p);
    order.tenders.push({ payment_id: p.id });
    const req = inv.payment_requests[0];
    req.total_completed_amount_money.amount += amount;
    inv.status = req.total_completed_amount_money.amount >= req.computed_amount_money.amount ? "PAID" : "PARTIALLY_PAID";
    inv.version++;
    return p;
  }
  /** A payment in Square that isn't for one of our invoices (e.g. an in-person sale). */
  outsidePayment(amount: number, customerId?: string): MockPayment {
    const p: MockPayment = { id: this.id("PAY"), status: "COMPLETED", amount_money: { amount, currency: "USD" }, source_type: "CARD", created_at: new Date().toISOString(), order_id: this.id("ORDX"), customer_id: customerId };
    this.payments.set(p.id, p);
    return p;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://mock");
      const path = decodeURIComponent(url.pathname);
      const method = req.method ?? "GET";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      this.calls.push({ method, path, body });
      const send = (status: number, b: unknown) => {
        if (this.dropOnce.has(`${method} ${path}`)) {
          this.dropOnce.delete(`${method} ${path}`);
          req.socket.destroy();
          return;
        }
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (path === "/resend/emails") {
        this.emails.push({ ...(body as { to: string[]; subject: string; text: string; html?: string }), idempotencyKey: String(req.headers["idempotency-key"] ?? "") || undefined });
        return send(200, { id: `em_${this.emails.length}` });
      }
      // Test controls (fictional): a client pays a published invoice, or an outside payment appears.
      if (method === "POST" && path === "/__mock/pay") return send(200, { payment: this.pay(String(body?.invoiceId), Number(body?.amount), String(body?.sourceType ?? "CARD")) });
      if (method === "POST" && path === "/__mock/outside-payment") return send(200, { payment: this.outsidePayment(Number(body?.amount), body?.customerId ? String(body.customerId) : undefined) });
      if (this.failAll) return send(this.failAll, { errors: [{ code: "SERVICE_UNAVAILABLE", detail: "Down for a test." }] });
      if (req.headers.authorization !== `Bearer ${this.token}`) return send(401, { errors: [{ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED", detail: "This request could not be authorized." }] });
      const once = <T>(key: unknown, make: () => T): T => {
        const k = `${path}|${String(key)}`;
        if (key && this.keys.has(k)) return this.keys.get(k) as T;
        const v = make();
        if (key) this.keys.set(k, v);
        return v;
      };
      const err = (status: number, code: string, detail: string) => send(status, { errors: [{ code, detail }] });
      const m = (re: RegExp) => re.exec(path);
      let r: RegExpExecArray | null;

      if (path === "/oauth2/token/status") return send(200, this.scopes ? { scopes: this.scopes, merchant_id: "MFICT" } : { merchant_id: "MFICT" });
      if (path === "/v2/locations/LOC1") return send(200, { location: { id: "LOC1", name: "Main (fictional)", business_name: "Fictional Office", status: "ACTIVE", currency: "USD", country: "US" } });
      if (method === "GET" && path === "/v2/payments") return send(200, { payments: [] });
      if (method === "POST" && path === "/v2/customers/search") {
        const f = ((body?.query as { filter?: Record<string, { exact?: string }> })?.filter ?? {}) as Record<string, { exact?: string }>;
        const hits = this.customers.filter((c) => (f.email_address?.exact ? c.email_address?.toLowerCase() === f.email_address.exact.toLowerCase() : true) && (f.phone_number?.exact ? c.phone_number === f.phone_number.exact : true));
        return send(200, hits.length ? { customers: hits } : {});
      }
      if (method === "POST" && path === "/v2/customers") {
        const c = once(body?.idempotency_key, () => {
          const made: MockCustomer = { id: this.id("CUST"), created_at: new Date().toISOString(), ...(body as Partial<MockCustomer>) } as MockCustomer;
          delete (made as Record<string, unknown>).idempotency_key;
          this.customers.push(made);
          return made;
        });
        return send(200, { customer: c });
      }
      if ((r = m(/^\/v2\/customers\/([^/]+)$/)) && method === "GET") {
        const c = this.customers.find((x) => x.id === r![1]);
        return c ? send(200, { customer: c }) : err(404, "NOT_FOUND", "Customer not found.");
      }
      if (method === "POST" && path === "/v2/orders") {
        const o = once(body?.idempotency_key, () => {
          const order = body!.order as { customer_id?: string; line_items: { quantity: string; base_price_money: Money }[]; discounts?: { amount_money: Money }[] };
          const gross = order.line_items.reduce((s, l) => s + Number(l.quantity) * l.base_price_money.amount, 0);
          const off = (order.discounts ?? []).reduce((s, d) => s + d.amount_money.amount, 0);
          const made = { id: this.id("ORD"), customer_id: order.customer_id, total: gross - off, line_items: order.line_items, discounts: order.discounts, tenders: [] as { payment_id: string }[] };
          this.orders.set(made.id, made);
          return made;
        });
        return send(200, { order: { id: o.id, total_money: { amount: o.total, currency: "USD" } } });
      }
      if ((r = m(/^\/v2\/orders\/([^/]+)$/)) && method === "GET") {
        const o = this.orders.get(r[1]);
        return o ? send(200, { order: { id: o.id, tenders: o.tenders } }) : err(404, "NOT_FOUND", "Order not found.");
      }
      if (method === "POST" && path === "/v2/invoices") {
        const inv = once(body?.idempotency_key, () => {
          const i = body!.invoice as Omit<MockInvoice, "id" | "version" | "status"> & { payment_requests: { request_type: string; due_date: string }[] };
          const order = this.orders.get(i.order_id);
          if (!order) return null;
          const made: MockInvoice = { ...i, id: `inv:0-${this.id("SQINV")}`, version: 0, status: "DRAFT", payment_requests: i.payment_requests.map((p, n) => ({ ...p, uid: `pr${n}`, computed_amount_money: { amount: order.total, currency: "USD" }, total_completed_amount_money: { amount: 0, currency: "USD" } })) };
          this.invoices.set(made.id, made);
          return made;
        });
        return inv ? send(200, { invoice: inv }) : err(400, "INVALID_REQUEST_ERROR", "Order not found.");
      }
      if (method === "POST" && path === "/v2/invoices/search") {
        const f = (body?.query as { filter?: { customer_ids?: string[] } })?.filter ?? {};
        return send(200, { invoices: [...this.invoices.values()].filter((i) => !f.customer_ids || f.customer_ids.includes(i.primary_recipient.customer_id)) });
      }
      if ((r = m(/^\/v2\/invoices\/([^/]+)\/publish$/)) && method === "POST") {
        const inv = this.invoices.get(r[1]);
        if (!inv) return err(404, "NOT_FOUND", "Invoice not found.");
        const out = once(body?.idempotency_key, () => {
          if (inv.status !== "DRAFT") return "not-draft";
          if (body?.version !== inv.version) return "version";
          inv.status = "UNPAID";
          inv.version++;
          inv.public_url = `https://squareupsandbox.com/pay-invoice/${inv.id}`;
          return { ...inv };
        });
        if (out === "version") return err(400, "VERSION_MISMATCH", "Version mismatch.");
        if (out === "not-draft") return err(400, "BAD_REQUEST", "Only a draft can be published.");
        return send(200, { invoice: out });
      }
      if ((r = m(/^\/v2\/invoices\/([^/]+)\/cancel$/)) && method === "POST") {
        const inv = this.invoices.get(r[1]);
        if (!inv) return err(404, "NOT_FOUND", "Invoice not found.");
        if (body?.version !== inv.version) return err(400, "VERSION_MISMATCH", "Version mismatch.");
        if (!["UNPAID", "SCHEDULED", "PARTIALLY_PAID"].includes(inv.status)) return err(400, "BAD_REQUEST", `Can't cancel a ${inv.status} invoice.`);
        inv.status = "CANCELED";
        inv.version++;
        return send(200, { invoice: inv });
      }
      if ((r = m(/^\/v2\/invoices\/([^/]+)$/))) {
        const inv = this.invoices.get(r[1]);
        if (!inv) return err(404, "NOT_FOUND", "Invoice not found.");
        if (method === "GET") return send(200, { invoice: inv });
        if (method === "DELETE") {
          if (inv.status !== "DRAFT") return err(400, "BAD_REQUEST", "Only drafts can be deleted.");
          this.invoices.delete(inv.id);
          return send(200, {});
        }
      }
      if ((r = m(/^\/v2\/payments\/([^/]+)$/)) && method === "GET") {
        const p = this.payments.get(r[1]);
        return p ? send(200, { payment: p }) : err(404, "NOT_FOUND", "Payment not found.");
      }
      return err(404, "NOT_FOUND", `Mock has no ${method} ${path}`);
    });
  }
}
