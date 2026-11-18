import { describe, expect, test } from "bun:test";
import { inferListRoles } from "./list-roles";

describe("inferListRoles", () => {
  test("old client board", () => {
    expect(inferListRoles(["Requests", "In Progress", "Client Review", "Done"])).toEqual([
      "intake", "active", "review", "done",
    ]);
  });
  test("website style board", () => {
    expect(inferListRoles(["Discovery", "Design", "Build", "Client review", "Live"])).toEqual([
      "active", "active", "active", "review", "done",
    ]);
  });
  test("leaves custom boards alone", () => {
    expect(inferListRoles(["Monday", "Tuesday", "Wednesday"])).toBeNull();
    expect(inferListRoles(["Done"])).toBeNull();
    expect(inferListRoles(["Done", "Doing"])).toBeNull();
  });
  test("lists after done stay working lists", () => {
    expect(inferListRoles(["To do", "Doing", "Done", "Parking lot"])).toEqual([
      "intake", "active", "done", "active",
    ]);
  });
});
