import { and, eq, inArray, sql } from "drizzle-orm";

import { db, defer } from "../db";
import { cardFiles, workspaces } from "../db/schema";
import { jwtSecret } from "../middleware/auth";
import { HttpError } from "../lib/http";

/**
 * Minimal shape of a Cloudflare R2 bucket binding. On Workers the real
 * binding is passed in from `c.env.FILES`; the Bun dev server has no R2, so
 * it falls back to a local `.uploads/` folder with the same behaviour.
 */
export interface FileBucket {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{
    body: ReadableStream;
    size: number;
    httpMetadata?: { contentType?: string };
  } | null>;
  delete(keys: string | string[]): Promise<void>;
}

let r2: FileBucket | undefined;
let onWorkers = false;

/** Called per request on Workers with `c.env.FILES`. */
export function useBucket(bucket: FileBucket | undefined, workers = false) {
  if (bucket) r2 = bucket;
  if (workers) onWorkers = true;
}

/**
 * Files work with an R2 binding, or locally (disk). A Worker deployed
 * without the binding has neither, so uploads are switched off.
 */
export function filesAvailable() {
  return Boolean(r2) || !onWorkers;
}

const LOCAL_DIR = ".uploads";

const localBucket: FileBucket = {
  async put(key, value) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = `${LOCAL_DIR}/${key}`;
    await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    const bytes =
      value instanceof ReadableStream
        ? new Uint8Array(await new Response(value).arrayBuffer())
        : new Uint8Array(value as ArrayBuffer);
    await writeFile(path, bytes);
  },
  async get(key) {
    const { readFile } = await import("node:fs/promises");
    try {
      const bytes = await readFile(`${LOCAL_DIR}/${key}`);
      return { body: new Response(bytes).body!, size: bytes.byteLength };
    } catch {
      return null;
    }
  },
  async delete(keys) {
    const { rm } = await import("node:fs/promises");
    for (const key of Array.isArray(keys) ? keys : [keys])
      await rm(`${LOCAL_DIR}/${key}`, { force: true });
  },
};

export function bucket(): FileBucket {
  if (r2) return r2;
  if (onWorkers)
    throw new HttpError(503, "File uploads are coming soon.", {
      filesDisabled: true,
    });
  return localBucket;
}

/* ------------------------------ Signed URLs ------------------------------ */

async function hmac(value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`files:${jwtSecret()}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * A link that works without a login (needed for <img> tags and the client
 * portal) but expires. Expiry is rounded up to the hour so the same link is
 * produced for a whole hour, which keeps the portal's edge cache effective.
 */
export async function signedFilePath(fileId: string, hours = 2) {
  const hour = 60 * 60;
  const exp = (Math.ceil(Date.now() / 1000 / hour) + hours) * hour;
  return `/files/${fileId}/raw?exp=${exp}&sig=${await hmac(`${fileId}:${exp}`)}`;
}

export async function verifyFileSignature(
  fileId: string,
  exp: string | undefined,
  sig: string | undefined,
) {
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) * 1000 < Date.now()) return false;
  return (await hmac(`${fileId}:${exp}`)) === sig;
}

/* -------------------------------- Quotas -------------------------------- */

/** Bytes stored across every workspace this account owns. */
export async function storageUsedBytes(ownerId: string) {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${cardFiles.size}), 0)` })
    .from(cardFiles)
    .innerJoin(workspaces, eq(cardFiles.workspaceId, workspaces.id))
    .where(eq(workspaces.ownerId, ownerId));
  return Number(row?.total || 0);
}

/* -------------------------------- Cleanup -------------------------------- */

/**
 * Deletes the stored bytes for files about to disappear with a card, list,
 * board or workspace. Call it BEFORE the database delete (the cascade
 * removes the rows that hold the keys); the R2 delete runs after the
 * response.
 */
export async function purgeFiles(
  scope:
    | { cardIds: string[] }
    | { boardId: string }
    | { workspaceId: string },
) {
  const where =
    "cardIds" in scope
      ? scope.cardIds.length
        ? inArray(cardFiles.cardId, scope.cardIds)
        : undefined
      : "boardId" in scope
        ? eq(cardFiles.boardId, scope.boardId)
        : eq(cardFiles.workspaceId, scope.workspaceId);
  if (!where || !filesAvailable()) return;
  const rows = await db
    .select({ key: cardFiles.storageKey })
    .from(cardFiles)
    .where(and(where));
  if (!rows.length) return;
  const keys = rows.map((row) => row.key);
  defer(async () => {
    // R2 deletes up to 1,000 keys per call.
    for (let i = 0; i < keys.length; i += 1000)
      await bucket().delete(keys.slice(i, i + 1000));
  });
}
