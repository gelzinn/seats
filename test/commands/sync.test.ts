import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { syncSeats } from "../../src/commands/sync.ts";
import { tempHome } from "../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

describe("syncSeats", () => {
  test("shares Codex config between seats and keeps auth per account", () => {
    env = tempHome();
    const { home, write } = env;
    write(".config/seats/codex/work/auth.json", "work");
    write(".config/seats/codex/work/config.toml", '[projects."/repo"]\ntrust_level = "trusted"\n');
    write(".config/seats/codex/work/skills/review/SKILL.md", "review");
    write(".config/seats/codex/personal/auth.json", "personal");

    syncSeats(home, ["codex"]);

    const personal = join(home, ".config/seats/codex/personal");
    expect(lstatSync(join(personal, "config.toml")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(personal, "config.toml"), "utf8")).toContain("trusted");
    expect(readFileSync(join(personal, "skills/review/SKILL.md"), "utf8")).toBe("review");
    expect(lstatSync(join(personal, "auth.json")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(personal, "auth.json"), "utf8")).toBe("personal");
  });

  test("leaves a provider with a single seat untouched", () => {
    env = tempHome();
    const { home, write } = env;
    write(".codex/auth.json", "only");
    write(".codex/config.toml", "model = 'x'\n");

    expect(syncSeats(home)).toEqual({ linked: [], backups: [], merged: [], hooked: [], tidied: [] });
    expect(lstatSync(join(home, ".codex/config.toml")).isFile()).toBe(true);
    expect(existsSync(join(home, ".config/seats/shared"))).toBe(false);
  });
});

describe("syncSeats for Claude", () => {
  test("merges every seat and writes through the live symlink", () => {
    env = tempHome();
    const { home, write } = env;
    write(".config/seats/claude/primary/.claude.json", {
      projects: { [home]: { hasTrustDialogAccepted: true } },
      mcpServers: { docs: { type: "http" } },
    });
    const secondary = write(".claude-secondary/.claude.json", { projects: {}, userID: "two" });
    symlinkSync(".claude-secondary/.claude.json", join(home, ".claude.json"));

    const report = syncSeats(home, ["claude"]);
    expect(report.merged).toEqual([secondary]);

    const live = join(home, ".claude.json");
    expect(lstatSync(live).isSymbolicLink()).toBe(true);
    expect(readlinkSync(live)).toBe(".claude-secondary/.claude.json");
    expect(lstatSync(secondary).mode & 0o777).toBe(0o600);

    const data = JSON.parse(readFileSync(live, "utf8"));
    expect(data.userID).toBe("two");
    expect(data.projects[home]).toEqual({ hasTrustDialogAccepted: true });
    expect(data.mcpServers).toEqual({ docs: { type: "http" } });
  });

  test("skips a seat whose .claude.json does not parse", () => {
    env = tempHome();
    const broken = env.write(".claude-broken/.claude.json", "{ not json");
    env.write(".claude-ok/.claude.json", { projects: { "/p": { hasTrustDialogAccepted: true } } });
    syncSeats(env.home, ["claude"]);
    expect(readFileSync(broken, "utf8")).toBe("{ not json");
  });
});
