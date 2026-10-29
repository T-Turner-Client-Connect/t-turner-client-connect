import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Private file storage. On Netlify this is a Netlify Blobs store (never
 * publicly reachable — files are only served through the authenticated
 * /api/files route). Locally it's a git-ignored folder.
 */
type Driver = {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
};

// Client documents use their own store, separate from marketing flyers; the
// Owner's Office (receipts) has a third store no other route reads from.
const storeFor = (key: string) =>
  key.startsWith("owner_private/") ? "client-connect-owner" : key.startsWith("client_document/") ? "client-connect-documents" : "client-connect-files";

function onNetlify(): boolean {
  const forced = process.env.STORAGE_DRIVER;
  if (forced) return forced === "netlify";
  return Boolean(process.env.NETLIFY || process.env.NETLIFY_BLOBS_CONTEXT);
}

const netlifyDriver: Driver = {
  async put(key, data) {
    const { getStore } = await import("@netlify/blobs");
    await getStore({ name: storeFor(key), consistency: "strong" }).set(key, data.slice().buffer as ArrayBuffer);
  },
  async get(key) {
    const { getStore } = await import("@netlify/blobs");
    const buf = await getStore({ name: storeFor(key), consistency: "strong" }).get(key, { type: "arrayBuffer" });
    return buf ? new Uint8Array(buf) : null;
  },
  async remove(key) {
    const { getStore } = await import("@netlify/blobs");
    await getStore({ name: storeFor(key), consistency: "strong" }).delete(key);
  },
};

const LOCAL_ROOT = path.join(process.cwd(), ".data", "uploads");

function localPath(key: string) {
  if (!/^[a-z0-9/_-]+$/i.test(key)) throw new Error("Invalid storage key");
  return path.join(LOCAL_ROOT, key);
}

const localDriver: Driver = {
  async put(key, data) {
    const file = localPath(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  },
  async get(key) {
    try {
      return new Uint8Array(await readFile(localPath(key)));
    } catch {
      return null;
    }
  },
  async remove(key) {
    await rm(localPath(key), { force: true });
  },
};

export const storage: Driver = {
  put: (k, d) => (onNetlify() ? netlifyDriver : localDriver).put(k, d),
  get: (k) => (onNetlify() ? netlifyDriver : localDriver).get(k),
  remove: (k) => (onNetlify() ? netlifyDriver : localDriver).remove(k),
};

export function storageDriverName(): string {
  return onNetlify() ? "Netlify Blobs (private)" : "Local folder (.data/uploads — development only)";
}
