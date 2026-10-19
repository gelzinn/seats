import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "../../src/commands/add.ts";
import { findSeatFolder, removeSeat, renameSeat } from "../../src/commands/manage.ts";
import { processesUsing, type RunningProcess } from "../../src/processes.ts";
import { tempHome } from "../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

const store = (...parts: string[]) => join(env.home, ".config/seats/claude", ...parts);
const none = () => [];
const signedIn = { claudeAiOauth: { accessToken: "a", refreshToken: "r" } };

/** Two Claude seats, `primary` active through ~/.claude and ~/.claude.json, sharing settings.json. */
function twoSeats() {
  env = tempHome();
  env.write(".config/seats/shared/claude/settings.json", "{}");
  for (const slug of ["primary", "secondary"]) {
    env.write(`.config/seats/claude/${slug}/.credentials.json`, signedIn);
    env.write(`.config/seats/claude/${slug}/.claude.json`, { oauthAccount: { emailAddress: `${slug}@x` } });
    symlinkSync("../../shared/claude/settings.json", store(slug, "settings.json"));
  }
  symlinkSync(".config/seats/claude/primary", join(env.home, ".claude"));
  symlinkSync(".config/seats/claude/primary/.claude.json", join(env.home, ".claude.json"));
}

/** A `claude` session running on `dir`. */
const session = (dir: string): RunningProcess => ({
  pid: 4242,
  argv: ["/usr/bin/claude", "--resume"],
  env: { CLAUDE_CONFIG_DIR: dir },
});

describe("renameSeat", () => {
  test("moves the active seat and repoints the live paths", () => {
    twoSeats();
    mkdirSync(store("primary.lock"));

    const result = renameSeat(env.home, "claude:primary", "1", { processes: none });

    expect(result).toMatchObject({ id: "claude:1", dir: store("1"), active: true });
    expect(existsSync(store("primary"))).toBe(false);
    expect(existsSync(store("primary.lock"))).toBe(false);
    expect(readlinkSync(join(env.home, ".claude"))).toBe(".config/seats/claude/1");
    expect(JSON.parse(readFileSync(join(env.home, ".claude.json"), "utf8")).oauthAccount.emailAddress).toBe(
      "primary@x",
    );
    expect(readFileSync(store("1", "settings.json"), "utf8")).toBe("{}");
    expect(findSeatFolder(env.home, "claude:1").dir).toBe(store("1"));
  });

  test("leaves the live paths alone when another seat is active", () => {
    twoSeats();
    const result = renameSeat(env.home, "claude:secondary", "2", { processes: none });
    expect(result.active).toBe(false);
    expect(readlinkSync(join(env.home, ".claude"))).toBe(".config/seats/claude/primary");
    expect(lstatSync(store("2", ".credentials.json")).isFile()).toBe(true);
  });

  test("refuses a taken or malformed name, or a missing seat", () => {
    twoSeats();
    expect(() => renameSeat(env.home, "claude:primary", "secondary", { processes: none })).toThrow(
      "claude:secondary already exists",
    );
    expect(() => renameSeat(env.home, "claude:primary", "Work", { processes: none })).toThrow("lowercase");
    expect(() => renameSeat(env.home, "claude:nope", "x", { processes: none })).toThrow("No seat named claude:nope");
    expect(() => renameSeat(env.home, "gemini:default", "x", { processes: none })).toThrow("can't rename");
  });

  test("refuses while a session runs on the seat", () => {
    twoSeats();
    expect(() => renameSeat(env.home, "claude:primary", "1", { processes: () => [session(store("primary"))] })).toThrow(
      "in use by claude process 4242",
    );
    expect(existsSync(store("primary"))).toBe(true);
  });
});

describe("removeSeat", () => {
  test("signs the account out, then deletes the folder but not what it links to", async () => {
    twoSeats();
    const calls: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
    const run: Runner = async (command, args, vars) => {
      calls.push({ command, args, env: vars });
      return 0;
    };

    const result = await removeSeat(env.home, "claude:secondary", { processes: none, run });

    expect(result.signedOut).toBe(true);
    expect(calls).toEqual([
      { command: "claude", args: ["auth", "logout"], env: { CLAUDE_CONFIG_DIR: store("secondary") } },
    ]);
    expect(existsSync(store("secondary"))).toBe(false);
    expect(readFileSync(join(env.home, ".config/seats/shared/claude/settings.json"), "utf8")).toBe("{}");
  });

  test("skips the logout for a signed-out seat or with keepLogin", async () => {
    twoSeats();
    env.write(".config/seats/claude/secondary/.credentials.json", { claudeAiOauth: { accessToken: "" } });
    let ran = 0;
    const run: Runner = async () => ++ran && 0;

    await removeSeat(env.home, "claude:secondary", { processes: none, run });
    env.write(".config/seats/claude/third/.credentials.json", signedIn);
    await removeSeat(env.home, "claude:third", { processes: none, run, keepLogin: true });

    expect(ran).toBe(0);
    expect(existsSync(store("secondary"))).toBe(false);
    expect(existsSync(store("third"))).toBe(false);
  });

  test("keeps the seat when the logout fails", async () => {
    twoSeats();
    const run: Runner = async () => 1;
    await expect(removeSeat(env.home, "claude:secondary", { processes: none, run })).rejects.toThrow("--keep-login");
    expect(existsSync(store("secondary"))).toBe(true);
  });

  test("refuses the active seat and a seat in use", async () => {
    twoSeats();
    const run: Runner = async () => 0;
    await expect(removeSeat(env.home, "claude:primary", { processes: none, run })).rejects.toThrow("active");
    await expect(
      removeSeat(env.home, "claude:secondary", { processes: () => [session(store("secondary"))], run }),
    ).rejects.toThrow("in use");
    expect(existsSync(store("primary"))).toBe(true);
    expect(existsSync(store("secondary"))).toBe(true);
  });
});

describe("processesUsing", () => {
  test("matches the CLI by name and its config folder, not other programs", () => {
    const list = () => [
      session("/seats/a"),
      { pid: 2, argv: ["node", "/lib/node_modules/codex/bin/codex.js"], env: { CODEX_HOME: "/seats/a" } },
      { pid: 3, argv: ["fish"], env: { CLAUDE_CONFIG_DIR: "/seats/a" } },
      { pid: 4, argv: ["claude"], env: { CLAUDE_CONFIG_DIR: "/seats/b" } },
      { pid: process.pid, argv: ["claude"], env: { CLAUDE_CONFIG_DIR: "/seats/a" } },
    ];
    expect(processesUsing("claude", "CLAUDE_CONFIG_DIR", "/seats/a", list).map((item) => item.pid)).toEqual([4242]);
    expect(processesUsing("codex", "CODEX_HOME", "/seats/a/", list).map((item) => item.pid)).toEqual([2]);
  });
});
