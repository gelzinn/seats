import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDirectory, lexists } from "../../fs.ts";
import { storeDir } from "../../store.ts";

// Claude Desktop is an Electron app, so Chromium's `--user-data-dir` moves all
// of its state (sign-in, chats, settings, MCP servers) to a folder of our own.
// The app takes no single-instance lock and Chromium's lock lives inside each
// data folder, so profiles run side by side. These are not CLI seats: the app
// signs in on its own, and nothing here touches its default profile.

/** `~/.config/seats/claude-desktop`: one Electron user data folder per account. */
export const desktopDir = (home: string) => storeDir(home, "claude-desktop");

export const profileDir = (home: string, name: string) => join(desktopDir(home), name);

/** Why `name` can't name a desktop account, or undefined when it can. Same rule as `invalidSlug` in add.ts. */
export function invalidName(name: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
    return "Use lowercase letters, numbers and dashes, like work or side-project.";
  return undefined;
}

export type DesktopProfile = { name: string; dir: string; lastUsed: Date; signedIn: boolean };

/**
 * True once the app has saved a sign-in in the folder. Only checks that the
 * encrypted token entry is there and not empty; its value is never read out.
 */
export function signedIn(dir: string): boolean {
  try {
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
    return ["oauth:tokenCacheV2", "oauth:tokenCache"].some((key) => Boolean(config[key]));
  } catch {
    return false;
  }
}

/** Every desktop account, by name. Last used is the folder's mtime, which `seats desktop open` bumps. */
export function listProfiles(home: string): DesktopProfile[] {
  let names: string[] = [];
  try {
    names = readdirSync(desktopDir(home)).sort();
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, dir: profileDir(home, name) }))
    .filter(({ name, dir }) => !invalidName(name) && isDirectory(dir))
    .map(({ name, dir }) => ({ name, dir, lastUsed: statSync(dir).mtime, signedIn: signedIn(dir) }));
}

/** What a launch needs from the machine, so tests can stand in for it. */
export type DesktopHost = {
  platform: NodeJS.Platform;
  home: string;
  exists: (path: string) => boolean;
  /** Full path of a command on PATH. */
  which: (command: string) => string | null | undefined;
  /** Starts the app and resolves once it has started, or rejects if it can't. */
  launch: (command: string, args: string[]) => Promise<void>;
};

/**
 * The installed app. On macOS that's Claude.app in /Applications or
 * ~/Applications. On Linux it's `claude-desktop` on PATH, which both the
 * official beta package and the claude-desktop-debian community builds install.
 */
export function findApp(host: Pick<DesktopHost, "platform" | "home" | "exists" | "which">): string {
  if (host.platform === "darwin") {
    const app = ["/Applications/Claude.app", join(host.home, "Applications", "Claude.app")].find(host.exists);
    if (app) return app;
    throw new Error("Claude Desktop isn't installed. Get it from https://claude.ai/download, then try again.");
  }
  if (host.platform === "linux") {
    const binary = host.which("claude-desktop");
    if (binary) return binary;
    throw new Error(
      "claude-desktop isn't on your PATH. Install Claude Desktop for Linux " +
        "(https://code.claude.com/docs/en/desktop-linux), then try again.",
    );
  }
  throw new Error("seats opens Claude Desktop on macOS and Linux only.");
}

/**
 * The command that opens `app` on the data folder `dir`. On macOS `open -n`
 * starts a new instance instead of focusing the running one, and hands
 * everything after `--args` to the app.
 */
export function launchCommand(
  platform: NodeJS.Platform,
  app: string,
  dir: string,
): { command: string; args: string[] } {
  const flag = `--user-data-dir=${dir}`;
  return platform === "darwin"
    ? { command: "open", args: ["-n", "-a", app, "--args", flag] }
    : { command: app, args: [flag] };
}

/**
 * Starts the app detached and returns once it has started. `open` exits as
 * soon as the app is up, so its exit code is the answer; a Linux binary keeps
 * running, so the `spawn` event is. `CLAUDE_CONFIG_DIR` is dropped so the
 * Claude Code the app embeds doesn't inherit the caller's CLI seat.
 */
export function launchDetached(command: string, args: string[]): Promise<void> {
  const { CLAUDE_CONFIG_DIR: _, ...env } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", env });
    child.once("error", reject);
    if (command === "open") {
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`open exited with status ${code}.`))));
      return;
    }
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export const realHost = (home: string): DesktopHost => ({
  platform: process.platform,
  home,
  exists: existsSync,
  which: (command) => Bun.which(command),
  launch: launchDetached,
});

export type OpenResult = { dir: string; created: boolean; signedIn: boolean };

/**
 * Opens Claude Desktop on the account `name` as a new instance. The folder is
 * created on first use, and removed again if the app can't be started, so a
 * typo'd name or a missing app leaves nothing behind.
 */
export async function openProfile(host: DesktopHost, name: string): Promise<OpenResult> {
  const problem = invalidName(name);
  if (problem) throw new Error(problem);
  const app = findApp(host);
  const dir = profileDir(host.home, name);
  const created = !lexists(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { command, args } = launchCommand(host.platform, app, dir);
  try {
    await host.launch(command, args);
  } catch (error) {
    if (created) rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const now = new Date();
  utimesSync(dir, now, now);
  return { dir, created, signedIn: signedIn(dir) };
}

/**
 * Deletes the account `name` and everything in its folder. The name rule keeps
 * the path a direct child of the desktop folder; a symlink there loses only
 * the link, never what it points at.
 */
export function removeProfile(home: string, name: string): string {
  const problem = invalidName(name);
  if (problem) throw new Error(problem);
  const dir = profileDir(home, name);
  if (dirname(dir) !== desktopDir(home) || !lexists(dir)) throw new Error(`No desktop account named ${name}.`);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}
