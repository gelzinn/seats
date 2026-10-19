import { describe, expect, test } from "bun:test";
import { isPinned } from "../../src/commands/switch.ts";
import type { Pin } from "../../src/pins.ts";
import type { Seat } from "../../src/types.ts";

const seat = (id: string, kind: Seat["kind"] = "cli"): Seat => ({
  id,
  source: id.split(":")[0]!,
  provider: id.split(":")[0]!,
  kind,
  label: id,
  signedIn: true,
});

describe("isPinned", () => {
  test("marks the CLI seat a .seats file pins for its tool", () => {
    const pins = new Map<string, Pin>([["claude", { tool: "claude", slug: "acme", file: "/p/.seats" }]]);
    expect(isPinned(seat("claude:acme"), pins)).toBe(true);
    expect(isPinned(seat("claude:work"), pins)).toBe(false);
    expect(isPinned(seat("codex:acme"), pins)).toBe(false);
  });
});
