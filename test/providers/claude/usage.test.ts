import { describe, expect, test } from "bun:test";
import { parseClaudeUsage } from "../../../src/providers/claude/usage.ts";
import { parseCodexUsage } from "../../../src/providers/codex/usage.ts";

describe("parseClaudeUsage", () => {
  test("reads every window with a utilization", () => {
    const usage = parseClaudeUsage({
      five_hour: { utilization: 100, resets_at: "2030-01-01T15:00:00Z" },
      seven_day: { utilization: 42.5, resets_at: null },
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
    });
    expect(usage?.windows).toEqual([
      { name: "five_hour", usedPercent: 100, resetsAt: new Date("2030-01-01T15:00:00Z") },
      { name: "seven_day", usedPercent: 42.5, resetsAt: undefined },
    ]);
    expect(parseClaudeUsage({ error: "unauthorized" })).toBeUndefined();
  });
});

describe("parseCodexUsage", () => {
  test("reads the primary and secondary windows", () => {
    const now = Date.parse("2030-01-01T12:00:00Z");
    const usage = parseCodexUsage(
      { rate_limit: { primary_window: { used_percent: 100, reset_after_seconds: 3600 }, secondary_window: { used_percent: 30, reset_at: 1893520800 } } },
      now,
    );
    expect(usage?.windows).toEqual([
      { name: "primary_window", usedPercent: 100, resetsAt: new Date("2030-01-01T13:00:00Z") },
      { name: "secondary_window", usedPercent: 30, resetsAt: new Date(1893520800 * 1000) },
    ]);
    expect(parseCodexUsage({ plan_type: "free" })).toBeUndefined();
  });
});
