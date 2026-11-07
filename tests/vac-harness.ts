import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { Actor } from "@/lib/auth/actor";

/**
 * Test harness for View as Client: an in-memory cookie jar behind next/headers, a switchable staff
 * session, and helpers that expand a server-rendered page tree so its forms and actions can be
 * inspected. Each test file registers the mocks with:
 *   vi.mock("next/headers", async () => (await import("./vac-harness")).headersMock);
 *   vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<object>()), ...(await import("./vac-harness")).sessionMock }));
 *   vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
 */
export const h = { jar: new Map<string, string>(), staff: null as Actor | null };

export const headersMock = {
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    getAll: () => [...h.jar].map(([name, value]) => ({ name, value })),
    has: (n: string) => h.jar.has(n),
    set: (n: string | { name: string; value: string }, v?: string) => {
      if (typeof n === "string") h.jar.set(n, v ?? "");
      else h.jar.set(n.name, n.value);
    },
    delete: (n: string) => h.jar.delete(n),
  }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
};

class Redirect extends Error {
  digest: string;
  constructor(to: string) {
    super("NEXT_REDIRECT");
    this.digest = `NEXT_REDIRECT;replace;${to};307;`;
  }
}

export const sessionMock = {
  getCurrentUser: async () => h.staff,
  requireUser: async () => {
    if (!h.staff) throw new Redirect("/staff/login");
    return h.staff;
  },
};

export function reset() {
  h.jar.clear();
  h.staff = null;
}

/** Starts View as Client the way the route does (the signed cookie), for the signed-in staff member. */
export async function startPreview(clientId: string, loginId: string | null) {
  const { previewCookieValue, VAC_COOKIE } = await import("@/lib/portal/viewer");
  h.jar.set(VAC_COOKIE, previewCookieValue({ staffId: h.staff!.id, clientId, loginId }));
}

/** A real portal sign-in (session row + cookie, MFA passed), as the client's own browser has. */
export async function signInPortal(portalUserId: string) {
  const { createPortalSession, markPortalMfaPassed } = await import("@/lib/portal/session");
  const id = await createPortalSession(portalUserId);
  await markPortalMfaPassed(id);
}

/** Where a Next redirect/notFound points, or null for any other error. */
export function nextTarget(err: unknown): string | null {
  const d = (err as { digest?: string })?.digest;
  if (typeof d !== "string") return null;
  if (d.startsWith("NEXT_REDIRECT")) return d.split(";")[2] ?? "";
  if (d.startsWith("NEXT_HTTP_ERROR_FALLBACK")) return `http:${d.split(";")[1]}`;
  return null;
}

const HOOK_ERROR = /hook|Cannot read properties of null|useContext|dispatcher|is not a function/i;

/**
 * Expands a server-rendered tree: calls each function component (awaiting async ones) until only
 * host elements and client components (which need React to render — kept as leaves with their
 * props) remain. Next redirects and notFound propagate.
 */
export async function expand(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(expand));
  if (node && typeof (node as Promise<unknown>).then === "function") return expand(await (node as Promise<ReactNode>));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<Record<string, unknown>>;
  const props = el.props ?? {};
  if (typeof el.type === "function") {
    let out: unknown;
    try {
      out = (el.type as (p: unknown) => unknown)(props);
    } catch (err) {
      if (nextTarget(err) || !HOOK_ERROR.test(String((err as Error)?.message))) throw err;
      return { ...el, props: { ...props, children: await expand(props.children as ReactNode) } } as ReactElement;
    }
    return expand(out as ReactNode);
  }
  return { ...el, props: { ...props, children: await expand(props.children as ReactNode) } } as ReactElement;
}

/** Every element in an expanded tree. */
export function elements(node: ReactNode, out: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (isValidElement(node)) {
    const el = node as ReactElement<Record<string, unknown>>;
    out.push(el);
    elements(el.props?.children as ReactNode, out);
  }
  return out;
}

/** Every function passed as a prop anywhere in the tree (looking into objects and arrays). */
export function functionProps(node: ReactNode): ((...a: unknown[]) => unknown)[] {
  const fns: ((...a: unknown[]) => unknown)[] = [];
  const scan = (v: unknown, depth: number) => {
    if (typeof v === "function") fns.push(v as (...a: unknown[]) => unknown);
    else if (v && typeof v === "object" && depth < 4 && !isValidElement(v) && !(v instanceof Date)) for (const x of Object.values(v)) scan(x, depth + 1);
  };
  for (const el of elements(node)) for (const [k, v] of Object.entries(el.props ?? {})) if (k !== "children") scan(v, 0);
  return fns;
}

export const testIds = (node: ReactNode) => elements(node).map((e) => e.props?.["data-testid"]).filter((x): x is string => typeof x === "string");

/** All text in the tree (strings and numbers), joined. */
export function textOf(node: ReactNode, skip: ReadonlySet<string> = new Set()): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((n) => textOf(n, skip)).join(" ");
  if (isValidElement(node)) {
    const p = (node as ReactElement<{ children?: ReactNode; "data-testid"?: string }>).props;
    if (p["data-testid"] && skip.has(p["data-testid"])) return "";
    return textOf(p.children, skip);
  }
  return "";
}

/** The first element of a component type in an expanded or unexpanded tree. */
export function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  return elements(node).find((e) => e.type === type) ?? null;
}
