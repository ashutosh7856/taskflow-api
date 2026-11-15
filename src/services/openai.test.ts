import { describe, expect, test } from "bun:test";

import {
  buildOpenAiPayload,
  estimateAiCostMicrousd,
  extractResponseText,
  limitAiInput,
  supportsReasoningEffort,
} from "./openai";

describe("OpenAI Responses parsing", () => {
  test("uses the convenience output_text field", () => {
    expect(extractResponseText({ output_text: "ready" })).toBe("ready");
  });

  test("reads text from the canonical output content array", () => {
    expect(
      extractResponseText({
        output: [{ content: [{ type: "output_text", text: "board plan" }] }],
      }),
    ).toBe("board plan");
  });

  test("rejects an empty model response", () => {
    expect(() => extractResponseText({ output: [] })).toThrow("empty response");
  });

  test("estimates model spend in millionths of a dollar", () => {
    expect(estimateAiCostMicrousd("gpt-6-luna", 10_000, 1_000)).toBe(1500);
    expect(estimateAiCostMicrousd("gpt-4o-mini", 10_000, 1_000)).toBe(2100);
    expect(estimateAiCostMicrousd("gpt-4o", 10_000, 1_000)).toBe(35_000);
  });

  test("caps oversized workspace context", () => {
    const limited = limitAiInput("x".repeat(70_000));
    expect(limited.length).toBeLessThan(61_000);
    expect(limited).toContain("Context truncated");
  });

  test("does not send reasoning options to non-reasoning models", () => {
    const payload = buildOpenAiPayload("gpt-4o-mini", "Create a plan", {
      reasoningEffort: "medium",
    });

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload.model).toBe("gpt-4o-mini");
  });

  test("sends reasoning options to reasoning models", () => {
    expect(supportsReasoningEffort("gpt-6-luna")).toBe(true);
    expect(supportsReasoningEffort("o4-mini")).toBe(true);
    expect(
      buildOpenAiPayload("gpt-6-luna", "Create a plan", {
        reasoningEffort: "medium",
      }),
    ).toMatchObject({ reasoning: { effort: "medium" } });
  });
});
