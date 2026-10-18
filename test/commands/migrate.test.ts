import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { applyMigration, planMigration } from "../../src/commands/migrate.ts";
import { tempHome } from "../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

describe("migrate", () => {
  test("moves legacy folders into the store and repoints links", () => {
    env = tempHome();
    const { home, write } = env;
    write(".claude-primary/.claude.json", "{}");
    write(".claude-primary/skills/x/SKILL.md", "x");
    write(".claude-primary/settings.json", {
      statusLine: { command: `bash ${home}/.claude-primary/statusline.sh` },
    });
    write(".agents/skills/deslop/SKILL.md", "deslop");
    symlinkSync("../../.agents/skills/deslop", join(home, ".claude-primary/skills/deslop"));
    write(".claude-secondary/.claude.json", "{}");
    symlinkSync("../.claude-primary/skills", join(home, ".claude-secondary/skills"));
    symlinkSync(".claude-primary", join(home, ".claude"));
    symlinkSync(".claude-primary/.claude.json", join(home, ".claude.json"));

    const plan = planMigration(home);
    expect(plan.map((move) => move.to).sort()).toEqual([
      join(home, ".config/seats/claude/primary"),
      join(home, ".config/seats/claude/secondary"),
    ]);
    expect(existsSync(join(home, ".claude-primary"))).toBe(true);

    applyMigration(home, plan);

    const store = join(home, ".config/seats/claude");
    expect(existsSync(join(home, ".claude-primary"))).toBe(false);
    expect(readlinkSync(join(home, ".claude"))).toBe(".config/seats/claude/primary");
    expect(readlinkSync(join(home, ".claude.json"))).toBe(".config/seats/claude/primary/.claude.json");
    expect(readFileSync(join(store, "secondary/skills/x/SKILL.md"), "utf8")).toBe("x");
    expect(readFileSync(join(store, "primary/skills/deslop/SKILL.md"), "utf8")).toBe("deslop");
    expect(readFileSync(join(store, "primary/settings.json"), "utf8")).toContain(`${store}/primary/statusline.sh`);
  });

  test("blocks a move when the destination exists", () => {
    env = tempHome();
    env.write(".codex-work/auth.json", "{}");
    env.write(".config/seats/codex/work/auth.json", "{}");
    const [move] = planMigration(env.home);
    expect(move?.blocked).toBeDefined();
    expect(applyMigration(env.home, [move!])).toEqual([]);
  });
});
