import { z } from "zod";

export const nameSchema = z.object({
  name: z.string().min(1).max(120),
});

export const memberRoleSchema = z.enum(["admin", "member"]);

export const memberSchema = z.object({
  userId: z.string().uuid(),
  role: memberRoleSchema.default("member"),
});
