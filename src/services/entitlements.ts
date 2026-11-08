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
  aiHourlyRequests: number;
  aiDailyRequests: number;
};

export const planCatalog: Record<Plan, PlanEntitlements> = {
  free: {
    priceUsd: 0,
    seats: 1,
    aiRequests: 20,
    workspaces: 1,
    boards: 3,
    collaboration: false,
    aiHourlyRequests: 10,
    aiDailyRequests: 20,
  },
  pro: {
    priceUsd: 9,
    seats: 1,
    aiRequests: 500,
    workspaces: 5,
    boards: null,
    collaboration: false,
    aiHourlyRequests: 30,
    aiDailyRequests: 100,
  },
  business: {
    priceUsd: 24,
    seats: 25,
    aiRequests: null,
    workspaces: null,
    boards: null,
    collaboration: true,
    aiHourlyRequests: 40,
    aiDailyRequests: 200,
  },
};

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
  return subscription?.plan || "free";
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
    throw new HttpError(402, "Collaboration requires the Team plan", {
      upgradeRequired: true,
      requiredPlan: "business",
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
      `${planCatalog[plan].seats}-person account limit reached for the Team plan`,
      { upgradeRequired: true, seats: planCatalog[plan].seats },
    );
  }
}
