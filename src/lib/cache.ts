/**
 * Small read-through cache to save database reads on hot, rarely-changing
 * data. Two layers:
 *  1. In-memory, per Worker isolate / Bun process. Free, sub-millisecond.
 *     Isolates are reused across many requests, so hit rates are high.
 *  2. Cloudflare's edge Cache API (`caches.default`), shared by all isolates
 *     in a data center. Only used for responses safe to share (e.g. the
 *     public client portal). It's a no-op on Bun and on *.workers.dev.
 *
 * Keep TTLs short: correctness matters more than the last few reads.
 */

type Entry = { value: unknown; expires: number };
const memory = new Map<string, Entry>();
const MAX_ENTRIES = 2000;

export async function cached<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = memory.get(key);
  if (hit && hit.expires > now) return hit.value as T;
  const value = await load();
  if (memory.size >= MAX_ENTRIES) memory.clear();
  memory.set(key, { value, expires: now + ttlSeconds * 1000 });
  return value;
}

export function invalidate(...keys: string[]) {
  for (const key of keys) memory.delete(key);
}

/* ------------------------- Edge (Cache API) layer ------------------------ */

const EDGE_ORIGIN = "https://edge-cache.danto.internal";

function edgeCache(): Cache | null {
  try {
    const store = (
      globalThis as { caches?: CacheStorage & { default?: Cache } }
    ).caches;
    return store?.default || null;
  } catch {
    return null;
  }
}

/** Shared JSON cache for public responses. Falls back to memory only. */
export async function cachedEdgeJson<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<T> {
  const cache = edgeCache();
  // With a shared edge cache, skip the per-isolate memory layer: another
  // isolate can't see invalidateEdge() clearing its memory, and would keep
  // serving the old copy (e.g. an approval still "waiting") for the TTL.
  const read = async () => {
    const request = new Request(`${EDGE_ORIGIN}/${encodeURIComponent(key)}`);
    if (cache) {
      const match = await cache.match(request).catch(() => undefined);
      if (match) return (await match.json()) as T;
    }
    const value = await load();
    if (cache) {
      const put = cache
        .put(
          request,
          new Response(JSON.stringify(value), {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": `public, max-age=${ttlSeconds}`,
            },
          }),
        )
        .catch(() => undefined);
      if (waitUntil) waitUntil(put);
      else await put;
    }
    return value;
  };
  return cache ? read() : cached(`edge:${key}`, ttlSeconds, read);
}

export async function invalidateEdge(key: string) {
  invalidate(`edge:${key}`);
  const cache = edgeCache();
  if (cache)
    await cache
      .delete(new Request(`${EDGE_ORIGIN}/${encodeURIComponent(key)}`))
      .catch(() => undefined);
}

/** Test helper. */
export function clearCache() {
  memory.clear();
}
