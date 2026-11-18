import { describe, expect, test } from "bun:test";

import { blockerChanges } from "./cards";

const clean = { blockedReason: null, blockedOn: null, blockedAt: null, delayReason: null };

describe("blocked and delayed status", () => {
  test("blocking sets who and when; defaults to the team", () => {
    const out = blockerChanges(clean, { blockedReason: "  Need menu photos " });
    expect(out.blockedReason).toBe("Need menu photos");
    expect(out.blockedOn).toBe("team");
    expect(out.blockedAt).toBeInstanceOf(Date);
    expect(blockerChanges(clean, { blockedReason: "Photos", blockedOn: "client" }).blockedOn).toBe("client");
  });

  test("editing the reason keeps the original blocked time", () => {
    const since = new Date(Date.now() - 86400000);
    const out = blockerChanges(
      { ...clean, blockedReason: "Old", blockedOn: "client", blockedAt: since },
      { blockedReason: "New" },
    );
    expect(out.blockedAt).toBe(since);
    expect(out.blockedOn).toBe("client");
  });

  test("clearing the reason unblocks", () => {
    const out = blockerChanges(
      { ...clean, blockedReason: "x", blockedOn: "team", blockedAt: new Date() },
      { blockedReason: "" },
    );
    expect(out).toMatchObject({ blockedReason: null, blockedOn: null, blockedAt: null });
  });

  test("finishing a card clears blockers and delay", () => {
    const out = blockerChanges(
      { ...clean, blockedReason: "x", blockedOn: "team", blockedAt: new Date(), delayReason: "late" },
      { isCompleted: true },
    );
    expect(out).toEqual({ blockedReason: null, blockedOn: null, blockedAt: null, delayReason: null });
  });

  test("a new future due date clears the delay reason", () => {
    const out = blockerChanges({ ...clean, delayReason: "late" }, { dueDate: new Date(Date.now() + 86400000) });
    expect(out.delayReason).toBeNull();
  });
});
