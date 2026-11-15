import { and, asc, count, countDistinct, eq, ne } from "drizzle-orm";

import { db } from "../db";
import {
  boards,
  subscriptions,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { cached, invalidate } from "../lib/cache";
import { HttpError } from "../lib/http";

type Plan = "free" | "pro" | "business";
type PlanEntitlements = {
  priceUsd: number;
  /** Yearly price: 2 months free. */
  yearlyPriceUsd: number;
  seats: number;
  aiRequests: number | null;
  workspaces: number | null;
  boards: number | null;
  collaboration: boolean;
  workspacePulse: boolean;
  aiHourlyRequests: number;
  aiDailyRequests: number;
  clientPortals: number | null;
  portalBranding: boolean;
  whiteLabel: boolean;
  /** Total file storage across every workspace the account owns. */
  storageMb: number;
  /** Largest single upload. Cloudflare caps request bodies at 100 MB. */
  maxFileMb: number;
  /** AI writes and emails the client update every Friday. */
  weeklyUpdates: boolean;
};

export const planCatalog: Record<Plan, PlanEntitlements> = {
  free: {
    priceUsd: 0,
    yearlyPriceUsd: 0,
    seats: 1,
    aiRequests: 10,
    workspaces: 1,
    boards: 3,
    collaboration: false,
    workspacePulse: false,
    aiHourlyRequests: 10,
    aiDailyRequests: 20,
    clientPortals: 1,
    portalBranding: false,
    whiteLabel: false,
    storageMb: 250,
    maxFileMb: 10,
    weeklyUpdates: false,
  },
  pro: {
    priceUsd: 19,
    yearlyPriceUsd: 190,
    seats: 3,
    aiRequests: 300,
    workspaces: 5,
    boards: null,
    collaboration: true,
    workspacePulse: false,
    aiHourlyRequests: 30,
    aiDailyRequests: 75,
    clientPortals: null,
    portalBranding: true,
    whiteLabel: false,
    storageMb: 10 * 1024,
    maxFileMb: 50,
    weeklyUpdates: true,
  },
  business: {
    priceUsd: 49,
    yearlyPriceUsd: 490,
    seats: 10,
    aiRequests: 1500,
    workspaces: null,
    boards: null,
    collaboration: true,
    workspacePulse: true,
    aiHourlyRequests: 60,
    aiDailyRequests: 250,
    clientPortals: null,
    portalBranding: true,
    whiteLabel: true,
    storageMb: 50 * 1024,
    maxFileMb: 95,
    weeklyUpdates: true,
  },
};

export function effectivePlan(subscription?: {
  plan: Plan;
  billingStatus: "inactive" | "active" | "past_due" | "cancelled";
  currentPeriodEnd: Date | null;
}): Plan {
  if (!subscription) return "free";
  if (
    (subscription.billingStatus === "cancelled" ||
      subscription.billingStatus === "past_due") &&
    (!subscription.currentPeriodEnd ||
      subscription.currentPeriodEnd <= new Date())
  ) {
    return "free";
  }
  return subscription.plan;
}

export function hasSeatCapacity(
  currentSeats: number,
  plan: keyof typeof planCatalog,
) {
  return currentSeats < planCatalog[plan].seats;
}

/**
 * The plan behind a workspace owner. Checked on almost every write, so it's
 * cached for 60s per isolate; billing changes call invalidatePlan().
 */
export async function ownerPlan(ownerId: string): Promise<Plan> {
  const subscription = await cached(`sub:${ownerId}`, 60, () =>
    db.query.subscriptions.findFirst({
      where: eq(subscriptions.userId, ownerId),
    }),
  );
  return effectivePlan(subscription);
}

export function invalidatePlan(userId: string) {
  invalidate(`sub:${userId}`);
}

export async function assertWorkspaceCreationAvailable(ownerId: string) {
  const plan = await ownerPlan(ownerId);
  const limit = planCatalog[plan].workspaces;
  if (limit === null) return;
  const [{ total }] = await db
    .select({ total: count() })
    .from(workspaces)
    .where(eq(workspaces.ownerId, ownerId));
  if (Number(total) >= limit) {
    throw new HttpError(402, `${plan} plan workspace limit reached`, {
      upgradeRequired: true,
      workspaces: limit,
    });
  }
}

export async function assertBoardCreationAvailable(workspaceId: string) {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
  if (!workspace) throw new HttpError(404, "Workspace not found");
  const plan = await ownerPlan(workspace.ownerId);
  const limit = planCatalog[plan].boards;
  if (limit === null) return;
  const [{ total }] = await db
    .select({ total: count() })
    .from(boards)
    .innerJoin(workspaces, eq(boards.workspaceId, workspaces.id))
    .where(eq(workspaces.ownerId, workspace.ownerId));
  if (Number(total) >= limit) {
    throw new HttpError(402, `${plan} plan board limit reached`, {
      upgradeRequired: true,
      boards: limit,
    });
  }
}

export async function assertCollaborationAvailable(workspaceId: string) {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
  if (!workspace) throw new HttpError(404, "Workspace not found");
  const plan = await ownerPlan(workspace.ownerId);
  if (!planCatalog[plan].collaboration) {
    throw new HttpError(402, "Collaboration requires the Pro or Team plan", {
      upgradeRequired: true,
      requiredPlan: "pro",
    });
  }
  return { workspace, plan };
}

export async function assertWorkspaceSeatAvailable(
  workspaceId: string,
  candidateUserId?: string,
) {
  const { workspace, plan } = await assertCollaborationAvailable(workspaceId);
  if (candidateUserId) {
    const existing = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(
        and(
          eq(workspaces.ownerId, workspace.ownerId),
          eq(workspaceMembers.userId, candidateUserId),
        ),
      )
      .limit(1);
    if (existing.length) return;
  }
  const [{ seats }] = await db
    .select({ seats: countDistinct(workspaceMembers.userId) })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaces.ownerId, workspace.ownerId));
  if (!hasSeatCapacity(Number(seats), plan)) {
    throw new HttpError(
      402,
      `${planCatalog[plan].seats}-person account limit reached for the ${plan === "business" ? "Team" : "Pro"} plan`,
      { upgradeRequired: true, seats: planCatalog[plan].seats },
    );
  }
}

export async function assertWorkspacePulseAvailable(workspaceId: string) {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
  if (!workspace) throw new HttpError(404, "Workspace not found");
  const plan = await ownerPlan(workspace.ownerId);
  if (!planCatalog[plan].workspacePulse) {
    throw new HttpError(402, "Workspace Pulse requires the Team plan", {
      upgradeRequired: true,
      requiredPlan: "business",
    });
  }
  return { workspace, plan };
}

/**
 * On plans with a portal limit (Free), only the oldest N enabled portals stay
 * live. Extra ones (e.g. after a trial or downgrade) are paused, not deleted,
 * and come back as soon as the owner upgrades.
 */
export async function portalIsLive(ownerId: string, boardId: string) {
  const plan = await ownerPlan(ownerId);
  const limit = planCatalog[plan].clientPortals;
  if (limit === null) return true;
  const live = await db
    .select({ id: boards.id })
    .from(boards)
    .innerJoin(workspaces, eq(boards.workspaceId, workspaces.id))
    .where(and(eq(workspaces.ownerId, ownerId), eq(boards.portalEnabled, true)))
    .orderBy(asc(boards.createdAt))
    .limit(limit);
  return live.some((row) => row.id === boardId);
}

export async function assertPortalAvailable(
  workspaceId: string,
  boardId: string,
) {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
  if (!workspace) throw new HttpError(404, "Workspace not found");
  const plan = await ownerPlan(workspace.ownerId);
  const limit = planCatalog[plan].clientPortals;
  if (limit === null) return plan;
  const [{ total }] = await db
    .select({ total: count() })
    .from(boards)
    .innerJoin(workspaces, eq(boards.workspaceId, workspaces.id))
    .where(
      and(
        eq(workspaces.ownerId, workspace.ownerId),
        eq(boards.portalEnabled, true),
        ne(boards.id, boardId),
      ),
    );
  if (Number(total) >= limit) {
    throw new HttpError(
      402,
      `The Free plan includes ${limit} live client portal. Upgrade to Pro for unlimited portals.`,
      { upgradeRequired: true, requiredPlan: "pro", clientPortals: limit },
    );
  }
  return plan;
}
