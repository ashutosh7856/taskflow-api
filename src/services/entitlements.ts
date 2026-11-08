import { count, eq } from "drizzle-orm";

import { db } from "../db";
import { subscriptions, workspaceMembers, workspaces } from "../db/schema";
import { HttpError } from "../lib/http";

export const planCatalog = {
  free: { priceUsd: 0, seats: 3, aiRequests: 10 },
  pro: { priceUsd: 12, seats: 5, aiRequests: 100 },
  business: { priceUsd: 39, seats: 25, aiRequests: 500 },
} as const;

export function hasSeatCapacity(
  currentSeats: number,
  plan: keyof typeof planCatalog,
) {
  return currentSeats < planCatalog[plan].seats;
}

export async function assertWorkspaceSeatAvailable(workspaceId: string) {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
  if (!workspace) throw new HttpError(404, "Workspace not found");
  const subscription = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, workspace.ownerId),
  });
  const plan = subscription?.plan || "free";
  const [{ seats }] = await db
    .select({ seats: count() })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  if (!hasSeatCapacity(Number(seats), plan)) {
    throw new HttpError(
      402,
      `${planCatalog[plan].seats}-seat limit reached for the ${plan} plan`,
      { upgradeRequired: true, seats: planCatalog[plan].seats },
    );
  }
}
