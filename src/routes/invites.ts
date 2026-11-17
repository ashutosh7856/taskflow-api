import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { atomic, db } from "../db";
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
import {
  assertCollaborationAvailable,
  assertWorkspaceSeatAvailable,
} from "../services/entitlements";

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
  const targetWorkspaceId =
    scope === "workspace" ? targetId : await boardWorkspace(targetId);
  await assertCollaborationAvailable(targetWorkspaceId);

  const input = await body(c, inviteSchema);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  // Inviting the same email again refreshes the pending invite instead of
  // piling up duplicates.
  const pending = await db.query.invites.findFirst({
    where: and(
      eq(invites.email, input.email),
      scope === "workspace"
        ? eq(invites.workspaceId, targetId)
        : eq(invites.boardId, targetId),
      isNull(invites.acceptedAt),
    ),
  });
  const [invite] = pending
    ? await db
        .update(invites)
        .set({ role: input.role, invitedBy: userId, expiresAt })
        .where(eq(invites.id, pending.id))
        .returning()
    : await db
        .insert(invites)
        .values({
          email: input.email,
          role: input.role,
          scope,
          workspaceId: scope === "workspace" ? targetId : undefined,
          boardId: scope === "board" ? targetId : undefined,
          invitedBy: userId,
          expiresAt,
        })
        .returning();
  const email = await sendInviteEmail(invite);
  return c.json({ ...invite, emailSent: email.sent }, 201);
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
type InviteRow = typeof invites.$inferSelect;

async function inviteTargetName(invite: InviteRow) {
  const target =
    invite.scope === "workspace" && invite.workspaceId
      ? await db.query.workspaces.findFirst({
          where: eq(workspaces.id, invite.workspaceId),
        })
      : invite.boardId
        ? await db.query.boards.findFirst({
            where: eq(boards.id, invite.boardId),
          })
        : null;
  return target?.name || "Danto";
}

async function sendInviteEmail(invite: InviteRow) {
  const [inviter, targetName, existingUser] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, invite.invitedBy) }),
    inviteTargetName(invite),
    db.query.users.findFirst({ where: eq(users.email, invite.email) }),
  ]);
  const by = inviter?.name || "A teammate";
  return sendEmail({
    to: invite.email,
    subject: `${by} invited you to ${targetName}`,
    title: `Join ${targetName}`,
    eyebrow: "Invitation",
    message: `${by} invited you to collaborate on the ${invite.scope} “${targetName}”. ${existingUser ? "Sign in with this email to accept. You'll also see the invite at the top of your Danto dashboard." : "Create your free account with this email to accept."}`,
    details: [
      ["Invited by", by],
      [
        "Access",
        `${invite.scope === "workspace" ? "Workspace" : "Board"} · ${invite.role}`,
      ],
    ],
    actionLabel: "Accept invitation",
    footnote:
      "This invitation expires in 7 days. If you weren't expecting it, you can ignore this email.",
    actionUrl: frontendUrl(`/invites/${invite.token}`),
  });
}

/** Pending (not accepted, not expired) invites for a workspace or board. */
async function pendingInvites(
  c: Context<AppEnv>,
  scope: "workspace" | "board",
  targetId: string,
) {
  const userId = c.get("userId");
  if (scope === "workspace") await workspaceAccess(userId, targetId, true);
  else await boardAccess(userId, targetId, true);
  const rows = await db.query.invites.findMany({
    where: and(
      scope === "workspace"
        ? eq(invites.workspaceId, targetId)
        : eq(invites.boardId, targetId),
      isNull(invites.acceptedAt),
      gt(invites.expiresAt, new Date()),
    ),
    orderBy: desc(invites.createdAt),
    with: { inviter: { columns: { name: true } } },
  });
  return c.json(
    rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      invitedBy: row.inviter?.name || null,
    })),
  );
}

/** Loads an invite the caller may manage (manager of its workspace/board). */
async function managedInvite(c: Context<AppEnv>) {
  const invite = await db.query.invites.findFirst({
    where: and(eq(invites.id, c.req.param("id") || ""), isNull(invites.acceptedAt)),
  });
  if (!invite) throw new HttpError(404, "Invite not found");
  const userId = c.get("userId");
  if (invite.scope === "workspace" && invite.workspaceId)
    await workspaceAccess(userId, invite.workspaceId, true);
  else if (invite.boardId) await boardAccess(userId, invite.boardId, true);
  else throw new HttpError(404, "Invite not found");
  return invite;
}

invitesRouter.get("/workspaces/:id/invites", (c) =>
  pendingInvites(c, "workspace", c.req.param("id")),
);
invitesRouter.get("/boards/:id/invites", (c) =>
  pendingInvites(c, "board", c.req.param("id")),
);

invitesRouter.post("/invites/:id/resend", async (c) => {
  const invite = await managedInvite(c);
  const [fresh] = await db
    .update(invites)
    .set({ expiresAt: new Date(Date.now() + INVITE_TTL_MS) })
    .where(eq(invites.id, invite.id))
    .returning();
  const email = await sendInviteEmail(fresh);
  return c.json({ emailSent: email.sent });
});

invitesRouter.delete("/invites/:id", async (c) => {
  const invite = await managedInvite(c);
  await db.delete(invites).where(eq(invites.id, invite.id));
  return c.json({ revoked: true });
});

/** Invites waiting for the signed-in user (shown on their dashboard). */
invitesRouter.get("/invites/mine", async (c) => {
  const user = await db.query.users.findFirst({
    where: eq(users.id, c.get("userId")),
    columns: { email: true },
  });
  if (!user) return c.json([]);
  const rows = await db.query.invites.findMany({
    where: and(
      eq(invites.email, user.email.toLowerCase()),
      isNull(invites.acceptedAt),
      gt(invites.expiresAt, new Date()),
    ),
    orderBy: desc(invites.createdAt),
    with: { inviter: { columns: { name: true } } },
  });
  return c.json(
    await Promise.all(
      rows.map(async (row) => ({
        token: row.token,
        scope: row.scope,
        role: row.role,
        targetName: await inviteTargetName(row),
        invitedBy: row.inviter?.name || null,
        expiresAt: row.expiresAt,
      })),
    ),
  );
});

invitesRouter.post("/invites/:token/decline", async (c) => {
  const user = await db.query.users.findFirst({
    where: eq(users.id, c.get("userId")),
    columns: { email: true },
  });
  await db
    .delete(invites)
    .where(
      and(
        eq(invites.token, c.req.param("token") || ""),
        eq(invites.email, (user?.email || "").toLowerCase()),
        isNull(invites.acceptedAt),
      ),
    );
  return c.json({ declined: true });
});

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

  const inviteWorkspaceId =
    invite.scope === "workspace"
      ? invite.workspaceId
      : invite.boardId
        ? await boardWorkspace(invite.boardId)
        : null;
  if (inviteWorkspaceId) {
    const existing = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, inviteWorkspaceId),
        eq(workspaceMembers.userId, user.id),
      ),
    });
    if (!existing)
      await assertWorkspaceSeatAvailable(inviteWorkspaceId, user.id);
  }
  const memberships =
    invite.scope === "workspace" && invite.workspaceId
      ? [
          db
            .insert(workspaceMembers)
            .values({
              workspaceId: invite.workspaceId,
              userId: user.id,
              role: invite.role,
            })
            .onConflictDoNothing(),
        ]
      : invite.scope === "board" && invite.boardId && inviteWorkspaceId
        ? [
            db
              .insert(workspaceMembers)
              .values({
                workspaceId: inviteWorkspaceId,
                userId: user.id,
                role: "member",
              })
              .onConflictDoNothing(),
            db
              .insert(boardMembers)
              .values({
                boardId: invite.boardId,
                userId: user.id,
                role: invite.role,
              })
              .onConflictDoNothing(),
          ]
        : [];
  await atomic([
    ...memberships,
    db
      .update(invites)
      .set({ acceptedAt: new Date() })
      .where(eq(invites.id, invite.id)),
  ]);

  return c.json({ accepted: true, scope: invite.scope });
});

export default invitesRouter;
