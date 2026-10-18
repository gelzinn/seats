import { describe, expect, test } from "bun:test";
import { claudeWindowLabel, parseClaudeUsage, readClaudeUsage } from "../../../src/providers/claude/usage.ts";
import { codexWindowLabel, parseCodexUsage, readCodexUsage } from "../../../src/providers/codex/usage.ts";
import { tempHome } from "../../helpers/temp-home.ts";

describe("parseClaudeUsage", () => {
  test("reads every window with a utilization", () => {
    const usage = parseClaudeUsage({
      five_hour: { utilization: 100, resets_at: "2030-01-01T15:00:00Z" },
      seven_day: { utilization: 42.5, resets_at: null },
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
    });
    expect(usage?.windows).toEqual([
      { name: "five_hour", label: "5h", usedPercent: 100, resetsAt: new Date("2030-01-01T15:00:00Z") },
      { name: "seven_day", label: "Week", usedPercent: 42.5, resetsAt: undefined },
    ]);
    expect(parseClaudeUsage({ error: "unauthorized" })).toBeUndefined();
  });

  test("labels the 5-hour, weekly and per-model weekly windows", () => {
    expect(claudeWindowLabel("five_hour")).toBe("5h");
    expect(claudeWindowLabel("seven_day")).toBe("Week");
    expect(claudeWindowLabel("seven_day_opus")).toBe("Week (opus)");
    expect(claudeWindowLabel("seven_day_oauth_apps")).toBe("Week (oauth apps)");
    expect(claudeWindowLabel("something_new")).toBe("something_new");
  });
});

describe("parseCodexUsage", () => {
  test("reads the primary and secondary windows", () => {
    const now = Date.parse("2030-01-01T12:00:00Z");
    const usage = parseCodexUsage(
      {
        rate_limit: {
          primary_window: { used_percent: 100, reset_after_seconds: 3600 },
          secondary_window: { used_percent: 30, reset_at: 1893520800 },
        },
      },
      now,
    );
    expect(usage?.windows).toEqual([
      { name: "primary_window", label: "5h", usedPercent: 100, resetsAt: new Date("2030-01-01T13:00:00Z") },
      { name: "secondary_window", label: "Week", usedPercent: 30, resetsAt: new Date(1893520800 * 1000) },
    ]);
    expect(parseCodexUsage({ plan_type: "free" })).toBeUndefined();
  });

  test("labels a window from its length, since Free's primary window is a month", () => {
    const usage = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 30 * 24 * 3600 },
        secondary_window: null,
      },
    });
    expect(usage?.windows.map((window) => window.label)).toEqual(["Month"]);
    expect(codexWindowLabel("primary_window", 5 * 3600)).toBe("5h");
    expect(codexWindowLabel("secondary_window", 7 * 24 * 3600)).toBe("Week");
    expect(codexWindowLabel("primary_window")).toBe("5h");
    expect(codexWindowLabel("secondary_window")).toBe("Week");
  });
});

describe("reading usage without a usable token", () => {
  test("tells a missing token from an expired one, before any request", async () => {
    const temp = tempHome();
    try {
      const dir = `${temp.home}/seat`;
      expect(await readClaudeUsage(dir)).toEqual({ error: "no-token" });
      expect(await readCodexUsage(dir)).toEqual({ error: "no-token" });
      temp.write("seat/.credentials.json", { claudeAiOauth: { accessToken: "stub", expiresAt: Date.now() - 1000 } });
      expect(await readClaudeUsage(dir)).toEqual({ error: "expired" });
    } finally {
      temp.cleanup();
    }
  });
});
