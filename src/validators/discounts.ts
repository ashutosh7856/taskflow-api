import { z } from "zod";

/**
 * Admin discount codes. Inputs are normalised before they are checked so the
 * form's natural values (an "any" plan, an empty max-uses box, a number typed
 * as text) are accepted instead of failing with a bare 400.
 */

// "" means "cleared" (null); a missing field stays undefined so PATCH leaves it alone.
const blankToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value;

const toNumber = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? Number(value) : value;

const dateTime = z.preprocess(
  blankToNull,
  z.iso
    .datetime({ offset: true, message: "Use a valid date" })
    .nullable(),
).optional();

const maxRedemptions = z.preprocess(
  (value) => {
    const v = blankToNull(toNumber(value));
    // 0 in the "Max uses" box means "no limit", same as leaving it empty.
    return v === 0 ? null : v;
  },
  z
    .number({ message: "Max uses must be a whole number" })
    .int("Max uses must be a whole number")
    .positive("Max uses must be at least 1")
    .nullable(),
).optional();

export const discountPlanSchema = z.preprocess(
  (value) =>
    value === "any" || value === "all" ? null : blankToNull(value),
  z
    .enum(["pro", "business"], { message: "Plan must be Any, Pro or Team" })
    .nullable(),
).optional();

export const createDiscountSchema = z
  .object({
    code: z.preprocess(
      (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
      z
        .string({ message: "Code is required" })
        .min(3, "Code must be at least 3 characters")
        .max(30, "Code must be 30 characters or fewer")
        .regex(
          /^[A-Z0-9_-]+$/,
          "Code can only use letters, numbers, - and _",
        ),
    ),
    percentOff: z.preprocess(
      toNumber,
      z
        .number({ message: "% off is required" })
        .int("% off must be a whole number")
        .min(5, "% off must be between 5 and 95")
        .max(95, "% off must be between 5 and 95"),
    ),
    plan: discountPlanSchema,
    maxRedemptions,
    startsAt: dateTime,
    expiresAt: dateTime,
  })
  .refine(
    (input) =>
      !input.startsAt ||
      !input.expiresAt ||
      new Date(input.startsAt) < new Date(input.expiresAt),
    { message: "Expiry must be after the start date", path: ["expiresAt"] },
  );

export const updateDiscountSchema = z.object({
  active: z.boolean().optional(),
  maxRedemptions,
  expiresAt: dateTime,
});

export type CreateDiscountInput = z.infer<typeof createDiscountSchema>;
