import type { Context } from "hono";
import type { ZodError, ZodType } from "zod";

export type Variables = {
  userId: string;
  /** True only for sessions opened with an emailed admin code. */
  adminSession?: boolean;
};
export type AppEnv = { Variables: Variables };

export async function body<T>(c: Context, schema: ZodType<T>): Promise<T> {
  const result = schema.safeParse(await c.req.json().catch(() => null));
  if (!result.success)
    throw new HttpError(
      400,
      validationMessage(result.error),
      result.error.flatten(),
    );
  return result.data;
}

/**
 * The first problem, readable enough to show as-is in a form. Zod's built-in
 * messages don't name the field, so those get the field name in front.
 */
export function validationMessage(error: ZodError) {
  const issue = error.issues[0];
  if (!issue) return "Invalid request body";
  const field = issue.path.join(".");
  const generic = /^(Invalid input|Too (big|small)|Invalid (string|option))/.test(
    issue.message,
  );
  return field && generic ? `${field}: ${issue.message}` : issue.message;
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
