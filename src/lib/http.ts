import type { Context } from "hono";
import type { ZodType } from "zod";

export type Variables = { userId: string };
export type AppEnv = { Variables: Variables };

export async function body<T>(c: Context, schema: ZodType<T>): Promise<T> {
  const result = schema.safeParse(await c.req.json().catch(() => null));
  if (!result.success)
    throw new HttpError(400, "Invalid request body", result.error.flatten());
  return result.data;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const publicUser = <T extends { passwordHash?: string }>(user: T) => {
  const { passwordHash: _, ...safe } = user;
  return safe;
};
