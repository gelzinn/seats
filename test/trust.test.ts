import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { excludeItem, excludeTrust } from "../src/commands/exclude.ts";
import { syncSeats } from "../src/commands/sync.ts";
import type { RunningProcess } from "../src/processes.ts";
import { seatSourceById } from "../src/providers/index.ts";
import { pullTrust, pushFromSession, pushTrust, SESSION_HOOK_COMMAND } from "../src/trust.ts";
import { tempHome } from "./helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
beforeEach(() => (env = tempHome()));
afterEach(() => env.cleanup());

const claude = seatSourceById("claude");
const seat = (name: string) => join(env.home, ".config/seats/claude", name);
const file = (name: string) => join(seat(name), ".claude.json");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const trusted = (name: string) => Object.keys(json(file(name)).projects ?? {}).sort();
const none = () => [] as RunningProcess[];

/** Seats `work`, `personal` and `acme`; `work` has just trusted `/repo`. */
function threeSeats(): void {
  env.write(".config/seats/claude/work/.claude.json", { projects: { "/repo": { hasTrustDialogAccepted: true } } });
  env.write(".config/seats/claude/personal/.claude.json", { userID: "personal" });
  env.write(".config/seats/claude/acme/.claude.json", { userID: "acme" });
}

describe("pushTrust", () => {
  test("carries the trust a session gave to the other seats, never rewriting its own", () => {
    threeSeats();
    const before = readFileSync(file("work"), "utf8");
    expect(pushTrust(env.home, claude, seat("work"), none).sort()).toEqual([file("acme"), file("personal")]);
    expect(trusted("personal")).toEqual(["/repo"]);
    expect(trusted("acme")).toEqual(["/repo"]);
    expect(json(file("acme")).userID).toBe("acme");
    expect(readFileSync(file("work"), "utf8")).toBe(before);
  });

  test("skips seats that keep their own trust", () => {
    threeSeats();
    excludeTrust(env.home, "claude:acme");
    pushTrust(env.home, claude, seat("work"), none);
    expect(trusted("personal")).toEqual(["/repo"]);
    expect(trusted("acme")).toEqual([]);

    excludeTrust(env.home, "claude:work");
    env.write(".config/seats/claude/work/.claude.json", { projects: { "/other": { hasTrustDialogAccepted: true } } });
    expect(pushTrust(env.home, claude, seat("work"), none)).toEqual([]);
    expect(trusted("personal")).toEqual(["/repo"]);
  });

  test("skips seats whose Claude is open, by CLAUDE_CONFIG_DIR or as plain claude on ~/.claude", () => {
    threeSeats();
    symlinkSync(seat("acme"), join(env.home, ".claude"));
    const running = (): RunningProcess[] => [
      { pid: 1, argv: ["claude"], env: { CLAUDE_CONFIG_DIR: seat("personal") } },
      { pid: 2, argv: ["/usr/bin/claude", "--resume", "s1"], env: {} },
    ];
    expect(pushTrust(env.home, claude, seat("work"), running)).toEqual([]);
    expect(trusted("personal")).toEqual([]);
    expect(trusted("acme")).toEqual([]);

    // They catch up at their next launch.
    expect(pullTrust(env.home, claude, seat("personal"))).toEqual([file("personal")]);
    expect(trusted("personal")).toEqual(["/repo"]);
  });

  test("finds the seat from CLAUDE_CONFIG_DIR, else ~/.claude, and leaves a folder that isn't a seat alone", () => {
    threeSeats();
    expect(pushFromSession(env.home, { CLAUDE_CONFIG_DIR: join(env.home, "elsewhere") })).toEqual([]);
    expect(pushFromSession(env.home, {})).toEqual([]);

    symlinkSync(seat("work"), join(env.home, ".claude"));
    // Not this process's list: no claude runs in the temp HOME.
    expect(pushFromSession(env.home, {}).length).toBeGreaterThan(0);
    expect(trusted("personal")).toEqual(["/repo"]);
  });
});

describe("seats hook session", () => {
  const cli = join(import.meta.dir, "../src/cli.ts");

  test("prints nothing, reads its input and exits 0, even on a broken seat", () => {
    threeSeats();
    env.write(".config/seats/claude/acme/.claude.json", "{ not json");
    const run = Bun.spawnSync(["bun", cli, "hook", "session"], {
      stdin: Buffer.from('{"hook_event_name":"SessionStart","source":"startup"}'),
      env: { ...process.env, HOME: env.home, CLAUDE_CONFIG_DIR: seat("work") },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("");
    expect(run.stderr.toString()).toBe("");
    expect(trusted("personal")).toEqual(["/repo"]);
  });
});

describe("SESSION_HOOK_COMMAND", () => {
  test("is a silent no-op when seats isn't on the PATH", () => {
    const run = Bun.spawnSync(["/bin/sh", "-c", SESSION_HOOK_COMMAND], { env: { PATH: join(env.home, "empty") } });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString() + run.stderr.toString()).toBe("");
  });
});

describe("session hook registration", () => {
  const shared = () => join(env.home, ".config/seats/shared/claude/settings.json");
  const ours = { hooks: [{ type: "command", command: SESSION_HOOK_COMMAND }] };

  test("adds SessionStart and Stop to the shared settings once, next to the hooks already there", () => {
    const herdr = { matcher: "startup", hooks: [{ type: "command", command: "herdr-hook" }] };
    env.write(".config/seats/claude/work/.claude.json", {});
    env.write(".config/seats/claude/work/settings.json", { model: "opus", hooks: { SessionStart: [herdr] } });
    env.write(".config/seats/claude/personal/.claude.json", {});

    expect(syncSeats(env.home, ["claude"]).hooked).toEqual([realpathSync(shared())]);
    const settings = json(join(seat("personal"), "settings.json"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks).toEqual({ SessionStart: [herdr, ours], Stop: [ours] });

    expect(syncSeats(env.home, ["claude"]).hooked).toEqual([]);
    expect(json(shared()).hooks).toEqual({ SessionStart: [herdr, ours], Stop: [ours] });
  });

  test("creates the shared settings when no seat has any, and links every seat to it", () => {
    env.write(".config/seats/claude/work/.claude.json", {});
    env.write(".config/seats/claude/personal/.claude.json", {});
    syncSeats(env.home, ["claude"]);
    for (const name of ["work", "personal"])
      expect(json(join(seat(name), "settings.json")).hooks).toEqual({ SessionStart: [ours], Stop: [ours] });
  });

  test("a dry run reports it and writes nothing", () => {
    env.write(".config/seats/claude/work/.claude.json", {});
    env.write(".config/seats/claude/personal/.claude.json", {});
    expect(syncSeats(env.home, ["claude"], { dryRun: true }).hooked).toEqual([shared()]);
    expect(existsSync(shared())).toBe(false);
  });

  test("leaves alone a seat that keeps its own settings, and a shared file that doesn't parse", () => {
    env.write(".config/seats/claude/work/.claude.json", {});
    env.write(".config/seats/claude/personal/.claude.json", {});
    syncSeats(env.home, ["claude"]);
    excludeItem(env.home, "claude:personal", "settings.json");
    env.write(".config/seats/claude/personal/settings.json", { model: "own" });
    env.write(".config/seats/shared/claude/settings.json", "{ not json");

    expect(syncSeats(env.home, ["claude"]).hooked).toEqual([]);
    expect(readFileSync(shared(), "utf8")).toBe("{ not json");
    expect(json(join(seat("personal"), "settings.json"))).toEqual({ model: "own" });
  });
});
