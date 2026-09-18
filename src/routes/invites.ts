import { and, eq, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { db } from "../db";
import {
  boardMembers,
  boards,
  invites,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { boardAccess, boardWorkspace, workspaceAccess } from "../lib/access";
import { body, HttpError, type AppEnv } from "../lib/http";
import { memberRoleSchema } from "../validators/common";
import { frontendUrl, sendEmail } from "../services/email";

const invitesRouter = new Hono<AppEnv>();

const inviteSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase()),
  role: memberRoleSchema.default("member"),
});

async function createInvite(
  c: Context<AppEnv>,
  scope: "workspace" | "board",
  targetId: string,
) {
  const userId = c.get("userId");
  if (scope === "workspace") {
    await workspaceAccess(userId, targetId, true);
  } else {
    await boardAccess(userId, targetId, true);
  }

  const input = await body(c, inviteSchema);
  const [invite] = await db
    .insert(invites)
    .values({
      ...input,
      scope,
      workspaceId: scope === "workspace" ? targetId : undefined,
      boardId: scope === "board" ? targetId : undefined,
      invitedBy: userId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning();

  const inviter = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  const target =
    scope === "workspace"
      ? await db.query.workspaces.findFirst({
          where: eq(workspaces.id, targetId),
        })
      : await db.query.boards.findFirst({ where: eq(boards.id, targetId) });
  const email = await sendEmail({
    to: input.email,
    subject: `You were invited to ${target?.name || "TaskFlow"}`,
    title: `Join ${target?.name || "TaskFlow"}`,
    message: `${inviter?.name || "A teammate"} invited you to a ${scope} on TaskFlow.`,
    actionLabel: "Accept invitation",
    actionUrl: frontendUrl(`/invites/${invite.token}`),
  });

  return c.json({ ...invite, emailSent: email.sent }, 201);
}

invitesRouter.post("/workspaces/:id/invites", (c) =>
  createInvite(c, "workspace", c.req.param("id")),
);
invitesRouter.post("/boards/:id/invites", (c) =>
  createInvite(c, "board", c.req.param("id")),
);

invitesRouter.post("/invites/:token/accept", async (c) => {
  const invite = await db.query.invites.findFirst({
    where: and(
      eq(invites.token, c.req.param("token")),
      isNull(invites.acceptedAt),
    ),
  });
  if (!invite || invite.expiresAt < new Date()) {
    throw new HttpError(404, "Invite is invalid or expired");
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, c.get("userId")),
  });
  if (!user || user.email !== invite.email) {
    throw new HttpError(403, "Invite belongs to another email");
  }

  await db.transaction(async (tx) => {
    if (invite.scope === "workspace" && invite.workspaceId) {
      await tx
        .insert(workspaceMembers)
        .values({
          workspaceId: invite.workspaceId,
          userId: user.id,
          role: invite.role,
        })
        .onConflictDoNothing();
    }

    if (invite.scope === "board" && invite.boardId) {
      const workspaceId = await boardWorkspace(invite.boardId);
      await tx
        .insert(workspaceMembers)
        .values({
          workspaceId,
          userId: user.id,
          role: "member",
        })
        .onConflictDoNothing();
      await tx
        .insert(boardMembers)
        .values({
          boardId: invite.boardId,
          userId: user.id,
          role: invite.role,
        })
        .onConflictDoNothing();
    }

    await tx
      .update(invites)
      .set({ acceptedAt: new Date() })
      .where(eq(invites.id, invite.id));
  });

  return c.json({ accepted: true, scope: invite.scope });
});

export default invitesRouter;
