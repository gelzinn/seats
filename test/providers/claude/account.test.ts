import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { claudeAccount } from "../../../src/providers/claude/account.ts";
import { claudeSeats } from "../../../src/providers/claude/seats.ts";
import { tempHome } from "../../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
const path = process.env.PATH;
afterEach(() => {
  process.env.PATH = path;
  env?.cleanup();
});

const signedIn = (_seat: string) => ({
  claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 1, subscriptionType: "team", rateLimitTier: "default_claude_max_5x" },
});
/** What Claude Code leaves behind after signing out or a failed refresh. */
const blanked = { claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } };
const config = (email: string) => ({ oauthAccount: { emailAddress: email, organizationType: "claude_max" } });

describe("claudeAccount", () => {
  test("reads email and plan from the seat's files", () => {
    env = tempHome();
    env.write("work/.credentials.json", signedIn("work"));
    env.write("work/.claude.json", config("you@work.example"));
    expect(claudeAccount(join(env.home, "work"))).toEqual({ email: "you@work.example", plan: "Team 5x" });
  });

  test("treats blanked tokens as signed out, even with an account record left", () => {
    env = tempHome();
    env.write("work/.credentials.json", blanked);
    env.write("work/.claude.json", config("you@work.example"));
    expect(claudeAccount(join(env.home, "work"))).toBeUndefined();
  });

  test("falls back to the account record when the tokens live in the Keychain (macOS)", () => {
    env = tempHome();
    env.write("work/.claude.json", config("you@work.example"));
    expect(claudeAccount(join(env.home, "work"))).toEqual({ email: "you@work.example", plan: "Max" });
    env.write("empty/.claude.json", {});
    expect(claudeAccount(join(env.home, "empty"))).toBeUndefined();
  });
});

describe("claudeSeats.discover", () => {
  test("lists signed-in seats without running claude", async () => {
    env = tempHome();
    env.write(".config/seats/claude/work/.credentials.json", signedIn("work"));
    env.write(".config/seats/claude/work/.claude.json", config("you@work.example"));
    env.write(".config/seats/claude/old/.credentials.json", blanked);
    // Any attempt to run `claude` would fail with nothing on PATH.
    const empty = join(env.home, "empty-bin");
    mkdirSync(empty);
    process.env.PATH = empty;

    const seats = await claudeSeats.discover(env.home);

    expect(seats.map((seat) => [seat.id, seat.email, seat.plan])).toEqual([["claude:work", "you@work.example", "Team 5x"]]);
  });
});
