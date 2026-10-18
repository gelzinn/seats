import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { matchesFilter, signedOutSeats } from "../../src/commands/list.ts";
import type { Seat } from "../../src/types.ts";
import { tempHome } from "../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

const seat = (id: string, kind: Seat["kind"], source: string, provider = source): Seat => ({
  id,
  source,
  provider,
  kind,
  label: id,
  signedIn: true,
});

describe("matchesFilter", () => {
  const work = seat("claude:work", "cli", "claude");
  const openrouter = seat("api:openrouter", "api", "opencode-api", "openrouter");

  test("matches a kind, a tool, an API provider or a seat id", () => {
    expect(matchesFilter(work, undefined)).toBe(true);
    expect(matchesFilter(work, "cli")).toBe(true);
    expect(matchesFilter(work, "claude")).toBe(true);
    expect(matchesFilter(work, "claude:work")).toBe(true);
    expect(matchesFilter(openrouter, "openrouter")).toBe(true);
    expect(matchesFilter(work, "codex")).toBe(false);
    expect(matchesFilter(openrouter, "claude")).toBe(false);
  });
});

describe("signedOutSeats", () => {
  test("lists seat folders that aren't signed in, for the tool asked about", () => {
    env = tempHome();
    env.write(".config/seats/claude/work/.claude.json", "{}");
    env.write(".config/seats/claude/old/.claude.json", "{}");
    env.write(".config/seats/codex/personal/config.toml", "");
    const signedIn = [{ ...seat("claude:work", "cli", "claude"), dir: join(env.home, ".config/seats/claude/work") }];

    expect(signedOutSeats(env.home, signedIn, "claude").map((item) => item.id)).toEqual(["claude:old"]);
    expect(signedOutSeats(env.home, signedIn, undefined).map((item) => item.id)).toEqual([
      "claude:old",
      "codex:personal",
    ]);
    expect(signedOutSeats(env.home, signedIn, "api")).toEqual([]);
  });
});
