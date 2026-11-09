import { and, count, countDistinct, eq } from "drizzle-orm";

import { db } from "../db";
import {
  boards,
  subscriptions,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { HttpError } from "../lib/http";

type Plan = "free" | "pro" | "business";
type PlanEntitlements = {
  priceUsd: number;
  seats: number;
  aiRequests: number | null;
  workspaces: number | null;
  boards: number | null;
  collaboration: boolean;
  workspacePulse: boolean;
  aiHourlyRequests: number;
  aiDailyRequests: number;
};

export const planCatalog: Record<Plan, PlanEntitlements> = {
  free: {
    priceUsd: 0,
    seats: 1,
    aiRequests: 10,
    workspaces: 1,
    boards: 3,
    collaboration: false,
    workspacePulse: false,
    aiHourlyRequests: 10,
    aiDailyRequests: 20,
  },
  pro: {
    priceUsd: 12,
    seats: 3,
    aiRequests: 300,
    workspaces: 5,
    boards: null,
    collaboration: true,
    workspacePulse: false,
    aiHourlyRequests: 30,
    aiDailyRequests: 75,
  },
  business: {
    priceUsd: 39,
    seats: 10,
    aiRequests: 1500,
    workspaces: null,
    boards: null,
    collaboration: true,
    workspacePulse: true,
    aiHourlyRequests: 60,
    aiDailyRequests: 250,
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

async function ownerPlan(ownerId: string): Promise<Plan> {
  const subscription = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, ownerId),
  });
  return effectivePlan(subscription);
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
