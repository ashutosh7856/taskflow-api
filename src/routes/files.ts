import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db";
import { boards, cardFiles } from "../db/schema";
import { boardAccess, cardBoard } from "../lib/access";
import { invalidateEdge } from "../lib/cache";
import { HttpError, type AppEnv } from "../lib/http";
import { recordActivity } from "../services/activity";
import { ownerPlan, planCatalog } from "../services/entitlements";
import {
  bucket,
  filesAvailable,
  signedFilePath,
  storageUsedBytes,
  verifyFileSignature,
} from "../services/storage";

const MB = 1024 * 1024;

/**
 * What clients actually send for proofing. Anything that a browser could run
 * as a page (HTML, SVG, JS) is refused so a file link can never execute code.
 */
const allowedTypes = [
  /^image\/(png|jpe?g|gif|webp|avif|heic|heif)$/,
  /^application\/pdf$/,
  /^video\/(mp4|webm|quicktime)$/,
  /^audio\/(mpeg|mp4|wav|x-wav|ogg|webm|aac)$/,
  /^application\/(zip|x-zip-compressed)$/,
  /^text\/(plain|csv)$/,
  /^application\/(msword|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.ms-(excel|powerpoint))$/,
  /^font\/(ttf|otf|woff2?)$/,
];
/** Shown in the browser (preview); everything else downloads. */
const inlineTypes = /^(image\/(png|jpe?g|gif|webp|avif)|application\/pdf|video\/|audio\/)/;

function cleanName(value: string) {
  const name = value
    .replace(/[\u0000-\u001f\u007f/\\]/g, "")
    .trim()
    .slice(0, 160);
  return name || "file";
}

export async function fileView(file: typeof cardFiles.$inferSelect) {
  return {
    id: file.id,
    cardId: file.cardId,
    name: file.name,
    contentType: file.contentType,
    size: file.size,
    createdAt: file.createdAt,
    url: await signedFilePath(file.id),
  };
}

async function refreshPortal(boardId: string) {
  const board = await db.query.boards.findFirst({
    where: eq(boards.id, boardId),
    columns: { portalToken: true },
  });
  if (board?.portalToken) await invalidateEdge(`portal:${board.portalToken}`);
}

/* ------------------------- Authenticated routes ------------------------- */

const filesRouter = new Hono<AppEnv>();

filesRouter.get("/cards/:id/files", async (c) => {
  const cardId = c.req.param("id");
  await cardBoard(c.get("userId"), cardId);
  if (!filesAvailable())
    throw new HttpError(503, "File uploads are coming soon.", {
      filesDisabled: true,
    });
  const rows = await db.query.cardFiles.findMany({
    where: eq(cardFiles.cardId, cardId),
    orderBy: desc(cardFiles.createdAt),
  });
  return c.json(await Promise.all(rows.map(fileView)));
});

/**
 * Upload: the raw file is the request body (not multipart), so it streams
 * straight into storage without being held in the Worker's memory.
 * Headers: Content-Type, Content-Length, X-File-Name (URI-encoded).
 */
filesRouter.post("/cards/:id/files", async (c) => {
  const cardId = c.req.param("id");
  const userId = c.get("userId");
  const boardId = await cardBoard(userId, cardId);
  bucket(); // 503 early when storage isn't set up
  const board = await db.query.boards.findFirst({
    where: eq(boards.id, boardId),
    with: { workspace: true },
  });
  if (!board) throw new HttpError(404, "Board not found");

  const contentType = (c.req.header("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!allowedTypes.some((pattern) => pattern.test(contentType)))
    throw new HttpError(
      415,
      "This file type isn't supported. Upload images, PDFs, videos, audio, documents or ZIP files.",
    );
  const size = Number(c.req.header("content-length") || 0);
  if (!size) throw new HttpError(411, "The file is empty or its size is unknown");

  const plan = await ownerPlan(board.workspace.ownerId);
  const limits = planCatalog[plan];
  if (size > limits.maxFileMb * MB)
    throw new HttpError(
      413,
      `Files can be up to ${limits.maxFileMb} MB on the ${plan === "business" ? "Team" : plan === "pro" ? "Pro" : "Free"} plan.`,
      plan === "business" ? undefined : { upgradeRequired: true },
    );
  const used = await storageUsedBytes(board.workspace.ownerId);
  if (used + size > limits.storageMb * MB)
    throw new HttpError(
      413,
      `Storage is full (${Math.round(used / MB)} MB of ${limits.storageMb >= 1024 ? `${limits.storageMb / 1024} GB` : `${limits.storageMb} MB`} used). Delete old files${plan === "business" ? "" : " or upgrade for more space"}.`,
      plan === "business" ? undefined : { upgradeRequired: true },
    );

  let name = "file";
  try {
    name = cleanName(decodeURIComponent(c.req.header("x-file-name") || ""));
  } catch {
    name = cleanName(c.req.header("x-file-name") || "");
  }
  const body = c.req.raw.body;
  if (!body) throw new HttpError(400, "No file was sent");

  const id = crypto.randomUUID();
  const storageKey = `ws/${board.workspaceId}/b/${boardId}/c/${cardId}/${id}`;
  await bucket().put(storageKey, body, { httpMetadata: { contentType } });
  const [file] = await db
    .insert(cardFiles)
    .values({
      id,
      cardId,
      boardId,
      workspaceId: board.workspaceId,
      uploadedBy: userId,
      name,
      contentType,
      size,
      storageKey,
    })
    .returning();
  await recordActivity(userId, boardId, "file.uploaded", undefined, {
    cardId,
    name,
  });
  await refreshPortal(boardId);
  return c.json(await fileView(file), 201);
});

filesRouter.delete("/files/:id", async (c) => {
  const userId = c.get("userId");
  const file = await db.query.cardFiles.findFirst({
    where: eq(cardFiles.id, c.req.param("id")),
  });
  if (!file) throw new HttpError(404, "File not found");
  const membership = await boardAccess(userId, file.boardId);
  // Members can remove their own uploads; managers can remove any.
  if (membership.role === "member" && file.uploadedBy !== userId)
    throw new HttpError(403, "Only the uploader or a board admin can delete this file");
  await db.delete(cardFiles).where(eq(cardFiles.id, file.id));
  await bucket().delete(file.storageKey);
  await recordActivity(userId, file.boardId, "file.deleted", undefined, {
    cardId: file.cardId,
    name: file.name,
  });
  await refreshPortal(file.boardId);
  return c.body(null, 204);
});

export default filesRouter;

/* ---------------------- Public, signed file content ---------------------- */

export const publicFiles = new Hono<AppEnv>();

publicFiles.get("/:id/raw", async (c) => {
  const id = c.req.param("id");
  if (
    !/^[0-9a-f-]{36}$/i.test(id) ||
    !(await verifyFileSignature(id, c.req.query("exp"), c.req.query("sig")))
  )
    throw new HttpError(403, "This file link has expired. Reload the page.");
  const file = await db.query.cardFiles.findFirst({
    where: eq(cardFiles.id, id),
  });
  if (!file) throw new HttpError(404, "File not found");
  const object = await bucket().get(file.storageKey);
  if (!object) throw new HttpError(404, "File not found");
  const inline = inlineTypes.test(file.contentType);
  const encoded = encodeURIComponent(file.name);
  return new Response(object.body, {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.size),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encoded}`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      // A file is never a page: no scripts, no frames, no forms.
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
});

/** Visible files for the client portal, grouped by card. */
export async function portalFiles(boardId: string, cardIds: string[]) {
  if (!cardIds.length) return new Map<string, Awaited<ReturnType<typeof fileView>>[]>();
  const rows = await db.query.cardFiles.findMany({
    where: and(eq(cardFiles.boardId, boardId)),
    orderBy: desc(cardFiles.createdAt),
  });
  const visible = new Set(cardIds);
  const grouped = new Map<string, Awaited<ReturnType<typeof fileView>>[]>();
  for (const row of rows) {
    if (!visible.has(row.cardId)) continue;
    const list = grouped.get(row.cardId) || [];
    list.push(await fileView(row));
    grouped.set(row.cardId, list);
  }
  return grouped;
}
