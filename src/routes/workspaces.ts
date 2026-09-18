import { and, eq, or } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db";
import { users, workspaceMembers, workspaces } from "../db/schema";
import { workspaceAccess } from "../lib/access";
import { body, HttpError, type AppEnv } from "../lib/http";
import { nameSchema, memberSchema } from "../validators/common";
import { frontendUrl, sendEmail } from "../services/email";

const workspacesRouter = new Hono<AppEnv>();

workspacesRouter.get("/workspaces", async (c) => {
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      ownerId: workspaces.ownerId,
      role: workspaceMembers.role,
      createdAt: workspaces.createdAt,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, c.get("userId")));

  return c.json(rows);
});

workspacesRouter.post("/workspaces", async (c) => {
  const input = await body(c, nameSchema);
  const userId = c.get("userId");

  const workspace = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(workspaces)
      .values({ ...input, ownerId: userId })
      .returning();

    await tx.insert(workspaceMembers).values({
      workspaceId: created.id,
      userId,
      role: "owner",
    });

    return created;
  });

  return c.json(workspace, 201);
});

workspacesRouter.get("/workspaces/:id", async (c) => {
  const workspaceId = c.req.param("id");
  await workspaceAccess(c.get("userId"), workspaceId);

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    with: {
      members: {
        with: { user: { columns: { passwordHash: false } } },
      },
      boards: true,
    },
  });

  return c.json(workspace);
});

workspacesRouter.patch("/workspaces/:id", async (c) => {
  const workspaceId = c.req.param("id");
  await workspaceAccess(c.get("userId"), workspaceId, true);
  const input = await body(c, nameSchema);

  const [workspace] = await db
    .update(workspaces)
    .set(input)
    .where(eq(workspaces.id, workspaceId))
    .returning();

  return c.json(workspace);
});

workspacesRouter.delete("/workspaces/:id", async (c) => {
  const workspaceId = c.req.param("id");
  const membership = await workspaceAccess(c.get("userId"), workspaceId);

  if (membership.role !== "owner") {
    throw new HttpError(403, "Only the owner can delete a workspace");
  }

  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  return c.body(null, 204);
});

workspacesRouter.post("/workspaces/:id/members", async (c) => {
  const workspaceId = c.req.param("id");
  await workspaceAccess(c.get("userId"), workspaceId, true);
  const input = await body(c, memberSchema);

  const [membership] = await db
    .insert(workspaceMembers)
    .values({ ...input, workspaceId })
    .onConflictDoUpdate({
      target: [workspaceMembers.workspaceId, workspaceMembers.userId],
      set: { role: input.role },
    })
    .returning();

  const [targetUser, workspace, actor] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, input.userId) }),
    db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) }),
    db.query.users.findFirst({ where: eq(users.id, c.get("userId")) }),
  ]);
  const email = targetUser
    ? await sendEmail({
        to: targetUser.email,
        subject: `You were added to ${workspace?.name || "a workspace"}`,
        title: "You have a new workspace",
        message: `${actor?.name || "A teammate"} added you to ${workspace?.name || "a workspace"} on TaskFlow.`,
        actionLabel: "Open TaskFlow",
        actionUrl: frontendUrl("/"),
      })
    : { sent: false };

  return c.json({ ...membership, emailSent: email.sent }, 201);
});

workspacesRouter.delete("/workspaces/:id/members/:userId", async (c) => {
  const workspaceId = c.req.param("id");
  const targetUserId = c.req.param("userId");
  const membership = await workspaceAccess(c.get("userId"), workspaceId, true);

  if (membership.role !== "owner" && targetUserId !== c.get("userId")) {
    throw new HttpError(403, "Access denied");
  }

  await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, targetUserId),
        or(
          eq(workspaceMembers.role, "admin"),
          eq(workspaceMembers.role, "member"),
        ),
      ),
    );

  return c.body(null, 204);
});

export default workspacesRouter;
