import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  type DesktopHost,
  findApp,
  invalidName,
  launchCommand,
  listProfiles,
  openProfile,
  removeProfile,
} from "../../../src/providers/claude-desktop/index.ts";
import { tempHome } from "../../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

/** A host with the app installed where `platform` looks for it, recording launches instead of spawning. */
function fakeHost(home: string, platform: NodeJS.Platform, { installed = true, fails = false } = {}) {
  const launches: Array<{ command: string; args: string[] }> = [];
  const host: DesktopHost = {
    platform,
    home,
    exists: (path) => installed && path === "/Applications/Claude.app",
    which: (command) => (installed && command === "claude-desktop" ? "/usr/bin/claude-desktop" : null),
    launch: async (command, args) => {
      launches.push({ command, args });
      if (fails) throw new Error("spawn failed");
    },
  };
  return { host, launches };
}

describe("invalidName", () => {
  test("takes lowercase names with dashes", () => {
    expect(invalidName("work")).toBeUndefined();
    expect(invalidName("side-project2")).toBeUndefined();
  });

  test("refuses anything that could leave the desktop folder or isn't a plain name", () => {
    for (const name of ["", "../claude", "a/b", "Work", "-work", ".hidden", "my work"])
      expect(invalidName(name)).toBeString();
  });
});

describe("launchCommand", () => {
  test("macOS starts a new instance through open, with the flag after --args", () => {
    expect(launchCommand("darwin", "/Applications/Claude.app", "/p/work")).toEqual({
      command: "open",
      args: ["-n", "-a", "/Applications/Claude.app", "--args", "--user-data-dir=/p/work"],
    });
  });

  test("Linux runs the binary with the flag, keeping a path with spaces in one argument", () => {
    expect(launchCommand("linux", "/usr/bin/claude-desktop", "/my home/work")).toEqual({
      command: "/usr/bin/claude-desktop",
      args: ["--user-data-dir=/my home/work"],
    });
  });
});

describe("findApp", () => {
  test("finds Claude.app in ~/Applications too", () => {
    const host = { platform: "darwin" as const, home: "/u", exists: (p: string) => p === "/u/Applications/Claude.app" };
    expect(findApp({ ...host, which: () => null })).toBe("/u/Applications/Claude.app");
  });

  test("says when the app is missing, per platform", () => {
    env = tempHome();
    expect(() => findApp(fakeHost(env.home, "darwin", { installed: false }).host)).toThrow("isn't installed");
    expect(() => findApp(fakeHost(env.home, "linux", { installed: false }).host)).toThrow("isn't on your PATH");
  });

  test("refuses an unsupported OS", () => {
    env = tempHome();
    expect(() => findApp(fakeHost(env.home, "win32").host)).toThrow("macOS and Linux only");
  });
});

describe("openProfile", () => {
  test("creates the data folder on first use and launches the app on it", async () => {
    env = tempHome();
    const { host, launches } = fakeHost(env.home, "darwin");

    const result = await openProfile(host, "work");

    const dir = join(env.home, ".config/seats/claude-desktop/work");
    expect(result).toEqual({ dir, created: true, signedIn: false });
    expect(existsSync(dir)).toBe(true);
    expect(launches).toEqual([
      { command: "open", args: ["-n", "-a", "/Applications/Claude.app", "--args", `--user-data-dir=${dir}`] },
    ]);
  });

  test("reopens an existing account and sees that it is signed in", async () => {
    env = tempHome();
    env.write(".config/seats/claude-desktop/work/config.json", { "oauth:tokenCacheV2": "encrypted" });
    const { host, launches } = fakeHost(env.home, "linux");

    const result = await openProfile(host, "work");

    expect(result.created).toBe(false);
    expect(result.signedIn).toBe(true);
    expect(launches[0]!.command).toBe("/usr/bin/claude-desktop");
  });

  test("an empty token entry doesn't count as signed in", async () => {
    env = tempHome();
    env.write(".config/seats/claude-desktop/work/config.json", { "oauth:tokenCache": "" });
    expect((await openProfile(fakeHost(env.home, "linux").host, "work")).signedIn).toBe(false);
  });

  test("creates nothing when the name is invalid or the app is missing", async () => {
    env = tempHome();
    const desktop = join(env.home, ".config/seats/claude-desktop");
    await expect(openProfile(fakeHost(env.home, "darwin").host, "../claude")).rejects.toThrow("lowercase");
    await expect(openProfile(fakeHost(env.home, "darwin", { installed: false }).host, "work")).rejects.toThrow(
      "isn't installed",
    );
    expect(existsSync(join(desktop, "work"))).toBe(false);
  });

  test("removes a new folder when the app can't start, but keeps an existing one", async () => {
    env = tempHome();
    env.write(".config/seats/claude-desktop/old/config.json", "{}");
    const { host } = fakeHost(env.home, "linux", { fails: true });

    await expect(openProfile(host, "new")).rejects.toThrow("spawn failed");
    await expect(openProfile(host, "old")).rejects.toThrow("spawn failed");

    expect(existsSync(join(env.home, ".config/seats/claude-desktop/new"))).toBe(false);
    expect(existsSync(join(env.home, ".config/seats/claude-desktop/old/config.json"))).toBe(true);
  });
});

describe("listProfiles", () => {
  test("lists account folders by name and skips anything else", () => {
    env = tempHome();
    env.write(".config/seats/claude-desktop/work/config.json", { "oauth:tokenCacheV2": "x" });
    env.write(".config/seats/claude-desktop/personal/config.json", "{}");
    env.write(".config/seats/claude-desktop/notes.txt", "");
    mkdirSync(join(env.home, ".config/seats/claude-desktop/.cache"));

    const profiles = listProfiles(env.home);

    expect(profiles.map((profile) => [profile.name, profile.signedIn])).toEqual([
      ["personal", false],
      ["work", true],
    ]);
    expect(profiles[0]!.lastUsed).toBeInstanceOf(Date);
  });

  test("is empty before the first account", () => {
    env = tempHome();
    expect(listProfiles(env.home)).toEqual([]);
  });
});

describe("removeProfile", () => {
  test("deletes only that account's folder", () => {
    env = tempHome();
    const work = env.write(".config/seats/claude-desktop/work/config.json", "{}");
    const personal = env.write(".config/seats/claude-desktop/personal/config.json", "{}");
    const cliSeat = env.write(".config/seats/claude/work/.credentials.json", "{}");

    removeProfile(env.home, "work");

    expect(existsSync(work)).toBe(false);
    expect(existsSync(personal)).toBe(true);
    expect(existsSync(cliSeat)).toBe(true);
  });

  test("a symlinked account loses the link, not what it points at", () => {
    env = tempHome();
    const target = env.write("elsewhere/config.json", "{}");
    mkdirSync(join(env.home, ".config/seats/claude-desktop"), { recursive: true });
    symlinkSync(join(env.home, "elsewhere"), join(env.home, ".config/seats/claude-desktop/linked"));

    removeProfile(env.home, "linked");

    expect(existsSync(join(env.home, ".config/seats/claude-desktop/linked"))).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  test("refuses names outside the desktop folder and accounts that don't exist", () => {
    env = tempHome();
    const cliSeat = env.write(".config/seats/claude/config.json", "{}");
    expect(() => removeProfile(env.home, "../claude")).toThrow("lowercase");
    expect(() => removeProfile(env.home, "missing")).toThrow("No desktop account named missing");
    expect(existsSync(cliSeat)).toBe(true);
  });
});
