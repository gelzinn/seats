import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { time } from "../../src/commands/run.ts";
import {
  type ReadUsage,
  readAll,
  readable,
  resetsIn,
  usageJson,
  usageTable,
  windowCell,
} from "../../src/commands/usage.ts";
import type { Seat } from "../../src/types.ts";

const seat = (id: string, extra: Partial<Seat> = {}): Seat => {
  const source = id.split(":")[0]!;
  return {
    id,
    source,
    provider: source,
    kind: "cli",
    label: id,
    dir: `/seats/${id.replace(":", "/")}`,
    signedIn: true,
    ...extra,
  };
};

const now = Date.parse("2030-01-01T12:00:00Z");
const at = (minutes: number) => new Date(now + minutes * 60_000);
const plain = (text: string) => stripVTControlCharacters(text);

describe("resetsIn", () => {
  test("shows minutes under an hour", () => {
    expect(resetsIn(at(12), now)).toBe("in 12m");
    expect(resetsIn(at(-5), now)).toBe("in 0m");
  });

  test("shows hours and padded minutes within a day", () => {
    expect(resetsIn(at(72), now)).toBe("in 1h12");
    expect(resetsIn(at(65), now)).toBe("in 1h05");
  });

  test("shows the weekday and time once the reset is a day or more away", () => {
    const later = at(3 * 24 * 60);
    expect(resetsIn(later, now)).toBe(time(later));
  });
});

describe("windowCell", () => {
  test("reads like 82% · resets in 1h12, and rounds the percent", () => {
    expect(plain(windowCell({ name: "five_hour", usedPercent: 82.4, resetsAt: at(72) }, now))).toBe(
      "82% · resets in 1h12",
    );
    expect(plain(windowCell({ name: "seven_day", usedPercent: 3 }, now))).toBe("3%");
  });
});

describe("readable", () => {
  const seats = [
    seat("claude:work"),
    seat("codex:personal"),
    seat("gemini:default"),
    seat("claude:old", { signedIn: false }),
  ];

  test("keeps signed-in seats whose tool reports usage", () => {
    expect(readable(seats).map((item) => item.id)).toEqual(["claude:work", "codex:personal"]);
  });

  test("filters by tool or seat id", () => {
    expect(readable(seats, "codex").map((item) => item.id)).toEqual(["codex:personal"]);
    expect(readable(seats, "claude:work").map((item) => item.id)).toEqual(["claude:work"]);
    expect(readable(seats, "gemini")).toEqual([]);
  });
});

const stub: ReadUsage = async (item) =>
  item.id === "claude:work"
    ? {
        usage: {
          windows: [
            { name: "seven_day", label: "Week", usedPercent: 100, resetsAt: at(3 * 24 * 60) },
            { name: "five_hour", label: "5h", usedPercent: 82, resetsAt: at(72) },
            { name: "seven_day_opus", label: "Week (opus)", usedPercent: 10 },
          ],
        },
      }
    : { error: "expired" };

const seats = [
  seat("claude:work", { email: "you@work.example", plan: "Max 20x" }),
  seat("codex:personal", { email: "you@personal.example" }),
];

describe("usageTable", () => {
  test("puts 5h and Week first, and gives an unreadable seat a row with the reason", async () => {
    const lines = plain(usageTable(await readAll(seats, stub), now)).split("\n");
    expect(lines[1]!.split("│").map((cell) => cell.trim())).toEqual([
      "",
      "Seat",
      "Account",
      "Plan",
      "5h",
      "Week",
      "Week (opus)",
      "Note",
      "",
    ]);
    expect(lines[3]).toContain("82% · resets in 1h12");
    expect(lines[3]).toContain(`100% · resets ${time(at(3 * 24 * 60))}`);
    expect(lines[4]!.split("│").map((cell) => cell.trim())).toEqual([
      "",
      "codex:personal",
      "you@personal.example",
      "—",
      "—",
      "—",
      "—",
      "token expired: open the seat once so its CLI refreshes the token",
      "",
    ]);
  });
});

describe("usageJson", () => {
  test("lists every seat with its windows and ISO reset times", async () => {
    expect(usageJson(await readAll(seats, stub))).toEqual([
      {
        id: "claude:work",
        email: "you@work.example",
        plan: "Max 20x",
        windows: [
          { name: "seven_day", label: "Week", usedPercent: 100, resetsAt: at(3 * 24 * 60).toISOString() },
          { name: "five_hour", label: "5h", usedPercent: 82, resetsAt: at(72).toISOString() },
          { name: "seven_day_opus", label: "Week (opus)", usedPercent: 10, resetsAt: null },
        ],
      },
      {
        id: "codex:personal",
        email: "you@personal.example",
        plan: null,
        windows: [],
        error: "token expired: open the seat once so its CLI refreshes the token",
      },
    ]);
  });
});
