import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { body, HttpError, validationMessage } from "../lib/http";
import { createDiscountSchema, updateDiscountSchema } from "./discounts";

/** Exactly what the admin Discounts form sends (AdminPage.tsx, DiscountsTab). */
function formPayload(form: {
  code?: string;
  percentOff?: string;
  plan?: string;
  maxRedemptions?: string;
  expiresAt?: string;
}) {
  const f = {
    code: "FOUNDER50",
    percentOff: "50",
    plan: "any",
    maxRedemptions: "",
    expiresAt: "",
    ...form,
  };
  return {
    code: f.code.trim(),
    percentOff: Number(f.percentOff),
    plan: f.plan === "any" ? null : f.plan,
    maxRedemptions: f.maxRedemptions ? Number(f.maxRedemptions) : null,
    expiresAt: f.expiresAt
      ? new Date(`${f.expiresAt}T23:59:59`).toISOString()
      : null,
  };
}

const parse = (value: unknown) => createDiscountSchema.safeParse(value);
const firstError = (value: unknown) => {
  const result = parse(value);
  return result.success ? null : validationMessage(result.error);
};

describe("create discount: every plan option in the form", () => {
  for (const [option, stored] of [
    ["any", null],
    ["pro", "pro"],
    ["business", "business"],
  ] as const) {
    test(`plan "${option}" is accepted`, () => {
      const result = parse(formPayload({ plan: option }));
      expect(result.success).toBe(true);
      expect(result.data?.plan).toBe(stored);
    });

    test(`plan "${option}" with max uses and expiry is accepted`, () => {
      const result = parse(
        formPayload({ plan: option, maxRedemptions: "25", expiresAt: "2027-01-31" }),
      );
      expect(result.success).toBe(true);
      expect(result.data?.maxRedemptions).toBe(25);
      expect(result.data?.expiresAt).toBeString();
    });
  }

  test('raw "any", "" and a missing plan all mean every plan', () => {
    for (const plan of ["any", "", null, undefined]) {
      const result = parse({ code: "ALLPLANS", percentOff: 20, plan });
      expect(result.success).toBe(true);
      expect(result.data?.plan ?? null).toBeNull();
    }
  });

  test("an unknown plan is rejected with a readable message", () => {
    expect(firstError({ code: "ABC", percentOff: 20, plan: "free" })).toBe(
      "Plan must be Any, Pro or Team",
    );
  });
});

describe("create discount: field normalisation", () => {
  test("code is trimmed and upper-cased", () => {
    expect(parse({ code: "  launch_50 ", percentOff: 50 }).data?.code).toBe(
      "LAUNCH_50",
    );
  });

  test("numbers sent as text are accepted", () => {
    const result = parse({ code: "TEXTNUM", percentOff: "40", maxRedemptions: "10" });
    expect(result.data).toMatchObject({ percentOff: 40, maxRedemptions: 10 });
  });

  test("empty or 0 max uses means unlimited", () => {
    for (const maxRedemptions of ["", 0, "0", null]) {
      const result = parse({ code: "NOLIMIT", percentOff: 30, maxRedemptions });
      expect(result.success).toBe(true);
      expect(result.data?.maxRedemptions).toBeNull();
    }
  });

  test("empty expiry means never", () => {
    expect(parse({ code: "FOREVER", percentOff: 30, expiresAt: "" }).data?.expiresAt).toBeNull();
  });

  test("the boundaries 5% and 95% are allowed", () => {
    expect(parse(formPayload({ percentOff: "5" })).success).toBe(true);
    expect(parse(formPayload({ percentOff: "95" })).success).toBe(true);
  });
});

describe("create discount: bad input names the problem", () => {
  const cases: [string, unknown, string][] = [
    ["code too short", formPayload({ code: "AB" }), "Code must be at least 3 characters"],
    ["code with a space", { code: "SAVE 20", percentOff: 20 }, "Code can only use letters, numbers, - and _"],
    ["code missing", { percentOff: 20 }, "Code is required"],
    ["100% off", formPayload({ percentOff: "100" }), "% off must be between 5 and 95"],
    ["96% off", formPayload({ percentOff: "96" }), "% off must be between 5 and 95"],
    ["3% off", formPayload({ percentOff: "3" }), "% off must be between 5 and 95"],
    ["12.5% off", formPayload({ percentOff: "12.5" }), "% off must be a whole number"],
    ["% off left empty", formPayload({ percentOff: "" }), "% off must be between 5 and 95"],
    ["fractional max uses", formPayload({ maxRedemptions: "2.5" }), "Max uses must be a whole number"],
    ["negative max uses", formPayload({ maxRedemptions: "-1" }), "Max uses must be at least 1"],
    ["bad expiry", { code: "BADDATE", percentOff: 20, expiresAt: "next week" }, "Use a valid date"],
    [
      "expiry before start",
      { code: "BACKWARDS", percentOff: 20, startsAt: "2027-02-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z" },
      "Expiry must be after the start date",
    ],
  ];
  for (const [name, payload, message] of cases) {
    test(name, () => expect(firstError(payload)).toBe(message));
  }
});

describe("update discount", () => {
  test("fields that are not sent stay undefined (left unchanged)", () => {
    const result = updateDiscountSchema.safeParse({ active: false });
    expect(result.success).toBe(true);
    expect("maxRedemptions" in result.data! && result.data!.maxRedemptions !== undefined).toBe(false);
    expect(result.data?.expiresAt).toBeUndefined();
  });

  test("an explicit null or empty value clears the field", () => {
    const result = updateDiscountSchema.safeParse({ maxRedemptions: "", expiresAt: null });
    expect(result.data).toMatchObject({ maxRedemptions: null, expiresAt: null });
  });
});

describe("request body errors", () => {
  const request = (json: unknown) =>
    ({ req: { json: async () => json } }) as Parameters<typeof body>[0];

  test("a 400 names the failing field instead of a bare 'Invalid request body'", async () => {
    const error = await body(request({ name: "" }), z.object({ name: z.string().min(1) })).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.message).toStartWith("name: Too small");
  });

  test("custom messages are passed through untouched", async () => {
    const error = await body(request(formPayload({ percentOff: "96" })), createDiscountSchema).catch(
      (e) => e,
    );
    expect(error.message).toBe("% off must be between 5 and 95");
  });
});
