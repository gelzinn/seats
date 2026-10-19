import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { listSeatDirs, pinnedSeat, seatDir, seatEnv } from "../src/lib.ts";
import { tempHome } from "./helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

describe("lib", () => {
  test("resolves store and legacy seats, signed in or not", () => {
    env = tempHome();
    const { home, write } = env;
    write(".config/seats/claude/primary/.claude.json", "{}");
    write(".claude-legacy/.claude.json", "{}");

    expect(listSeatDirs("claude", home).map((seat) => seat.slug)).toEqual(["primary", "legacy"]);
    expect(seatDir("claude", "primary", home)).toBe(join(home, ".config/seats/claude/primary"));
    expect(seatEnv("claude", "legacy", home)).toEqual({
      CLAUDE_CONFIG_DIR: join(home, ".claude-legacy"),
    });
  });

  test("returns undefined for missing seats and CLIs without a config env", () => {
    env = tempHome();
    const { home, write } = env;
    write(".config/seats/codex/work/auth.json", "{}");
    write(".config/seats/gemini/work/oauth_creds.json", "{}");

    expect(seatEnv("claude", "missing", home)).toBeUndefined();
    expect(seatEnv("codex", "work", home)).toEqual({ CODEX_HOME: join(home, ".config/seats/codex/work") });
    expect(seatDir("gemini", "work", home)).toBe(join(home, ".config/seats/gemini/work"));
    expect(seatEnv("gemini", "work", home)).toBeUndefined();
  });

  test("reads the seat a project pins, without checking it exists", () => {
    env = tempHome();
    const file = env.write("project/.seats", 'claude = "work"\n');
    expect(pinnedSeat("claude", join(env.home, "project/src"))).toEqual({ slug: "work", file });
    expect(pinnedSeat("codex", join(env.home, "project"))).toBeUndefined();
  });
});
