import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { excludeItem } from "../src/commands/exclude.ts";
import { syncSeats } from "../src/commands/sync.ts";
import { claudeSessionHook } from "../src/providers/claude/session-hook.ts";
import { SESSION_HOOK_COMMAND } from "../src/trust.ts";
import { tempHome } from "./helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
beforeEach(() => (env = tempHome()));
afterEach(() => env.cleanup());

/** What herdr's `integration install claude` writes, for the hook script at `dir/hooks`. */
const HERDR_MATCHER = "^(startup|resume|clear|compact|fork)$";
const herdrHook = (dir: string) => `bash '${dir}/hooks/herdr-agent-state.sh' session`;
const group = (command: string, matcher?: string) => ({
  ...(matcher ? { matcher } : {}),
  hooks: [{ type: "command", command, timeout: 10 }],
});

const seat = (name: string) => join(env.home, ".config/seats/claude", name);
const sharedSettings = () => join(env.home, ".config/seats/shared/claude/settings.json");
const settings = () => JSON.parse(readFileSync(sharedSettings(), "utf8"));
/** The hooks of `event` other than seats' own session hook. */
const others = (event: string) =>
  settings()
    .hooks[event].map((entry: { hooks: Array<{ command: string }> }) => ({
      ...entry,
      hooks: entry.hooks.filter((hook) => hook.command !== SESSION_HOOK_COMMAND),
    }))
    .filter((entry: { hooks: unknown[] }) => entry.hooks.length > 0);

/**
 * Seats `1` and `4` sharing `hooks/` and `settings.json`, `~/.claude` leading
 * to seat 1, and the herdr hook registered three times as on a real machine:
 * from seat 1, from the live path and from seat 4.
 */
function threeCopies(): string {
  env.write(".config/seats/claude/1/hooks/herdr-agent-state.sh", "#!/bin/bash\n");
  env.write(".config/seats/claude/4/statusline-command.sh", "#!/bin/bash\n");
  env.write(".config/seats/claude/1/settings.json", {
    hooks: {
      SessionStart: [
        group(herdrHook(seat("1")), "*"),
        group(herdrHook(join(env.home, ".claude")), HERDR_MATCHER),
        group(herdrHook(seat("4")), HERDR_MATCHER),
      ],
      Stop: [group(`bash '${seat("1")}/hooks/notify.sh'`)],
    },
    statusLine: { type: "command", command: `bash ${seat("4")}/statusline-command.sh` },
  });
  env.write(".config/seats/claude/4/.claude.json", {});
  const live = join(env.home, ".claude");
  symlinkSync(seat("1"), live);
  return live;
}

describe("seats sync on hook paths", () => {
  test("points hooks at the live path and keeps one of each", () => {
    const live = threeCopies();
    const report = syncSeats(env.home, ["claude"]);
    expect(report.tidied).toEqual([sharedSettings()]);
    // The broadest matcher wins; herdr's next install swaps it for its own entry, without a copy.
    expect(others("SessionStart")).toEqual([group(herdrHook(live), "*")]);
    expect(others("Stop")).toEqual([group(`bash '${live}/hooks/notify.sh'`)]);
    expect(settings().statusLine.command).toBe(`bash ${live}/statusline-command.sh`);
    expect(syncSeats(env.home, ["claude"]).tidied).toEqual([]);
  });

  test("--dry-run reports the file and leaves it as it is", () => {
    threeCopies();
    syncSeats(env.home, ["claude"]);
    const before = readFileSync(sharedSettings(), "utf8");
    const hooks = settings().hooks;
    hooks.Stop.push(group(herdrHook(seat("4"))));
    env.write(".config/seats/shared/claude/settings.json", { ...settings(), hooks });
    const changed = readFileSync(sharedSettings(), "utf8");
    expect(changed).not.toBe(before);
    expect(syncSeats(env.home, ["claude"], { dryRun: true }).tidied).toEqual([sharedSettings()]);
    expect(readFileSync(sharedSettings(), "utf8")).toBe(changed);
  });

  test("leaves a path to an item that seat keeps its own copy of", () => {
    const live = threeCopies();
    excludeItem(env.home, "claude:4", "hooks");
    syncSeats(env.home, ["claude"]);
    expect(others("SessionStart")).toEqual([group(herdrHook(live), "*"), group(herdrHook(seat("4")), HERDR_MATCHER)]);
  });

  test("uses the shared folder's path when the active seat keeps its own copy", () => {
    threeCopies();
    env.write(".config/seats/claude/4/hooks/herdr-agent-state.sh", "#!/bin/bash\n");
    excludeItem(env.home, "claude:1", "hooks");
    syncSeats(env.home, ["claude"]);
    const shared = join(env.home, ".config/seats/shared/claude");
    // Seat 1's and the live path's own hooks/ stay; seat 4's reaches the shared one.
    expect(others("SessionStart")).toEqual([
      group(herdrHook(seat("1")), "*"),
      group(herdrHook(join(env.home, ".claude")), HERDR_MATCHER),
      group(herdrHook(shared), HERDR_MATCHER),
    ]);
  });

  test("repoints a path into a seat that's gone", () => {
    const live = threeCopies();
    syncSeats(env.home, ["claude"]);
    const hooks = settings().hooks;
    hooks.Stop = [group(`bash '${seat("old")}/hooks/notify.sh'`), group(`bash '${seat("4")}/other/x.sh'`)];
    env.write(".config/seats/shared/claude/settings.json", { ...settings(), hooks });
    syncSeats(env.home, ["claude"]);
    expect(others("Stop")).toEqual([group(`bash '${live}/hooks/notify.sh'`), group(`bash '${seat("4")}/other/x.sh'`)]);
  });
});

describe("claudeSessionHook.tidy", () => {
  const same = (command: string) => command;

  test("joins the matchers of a hook registered twice", () => {
    const next = claudeSessionHook.tidy!(
      { hooks: { SessionStart: [group("a", "startup"), group("b"), group("a", "resume")] } },
      same,
    );
    expect(next).toEqual({ hooks: { SessionStart: [group("a", "startup|resume"), group("b")] } });
  });

  test("keeps duplicates it can't merge, and entries it doesn't understand", () => {
    const shared = {
      matcher: "startup",
      hooks: [
        { type: "command", command: "a" },
        { type: "command", command: "c" },
      ],
    };
    const input = { hooks: { SessionStart: [shared, group("a", "resume"), "odd"] }, model: "opus" };
    expect(claudeSessionHook.tidy!(input, same)).toBeUndefined();
  });

  test("returns undefined when nothing changes", () => {
    expect(claudeSessionHook.tidy!({ statusLine: { command: "x" } }, same)).toBeUndefined();
    expect(claudeSessionHook.tidy!({}, same)).toBeUndefined();
  });
});
