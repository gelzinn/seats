import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { type SkillsTarget, syncSkills } from "../src/skills.ts";
import { tempHome } from "./helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

const at =
  (...parts: string[]) =>
  (home: string) =>
    join(home, ...parts);

describe("syncSkills", () => {
  const targets: SkillsTarget[] = [
    { id: "claude", dir: at(".claude/skills") },
    { id: "kiro", dir: at(".kiro/skills") },
    { id: "codex", native: true, dir: at(".codex/skills") },
  ];

  test("shares the skills tools use, not the whole library", () => {
    env = tempHome();
    const { home, write } = env;
    write(".agents/skills/used/SKILL.md", "used");
    write(".agents/skills/unused/SKILL.md", "unused");
    write(".kiro/skills/.keep", "");
    symlinkSync("../../.agents/skills/used", join(home, ".kiro/skills/used"));
    write(".claude/skills/mine/SKILL.md", "mine");
    write(".codex/skills/codex-only/SKILL.md", "codex");

    const report = syncSkills(home, targets);

    expect(report.imported.sort()).toEqual(["codex-only", "mine"]);
    // Claude keeps a link to its moved skill; Codex reads ~/.agents/skills, so it gets none.
    expect(lstatSync(join(home, ".claude/skills/mine")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home, ".codex/skills/codex-only"))).toBe(false);
    expect(readFileSync(join(home, ".agents/skills/codex-only/SKILL.md"), "utf8")).toBe("codex");

    for (const tool of [".claude", ".kiro"]) {
      for (const skill of ["used", "mine", "codex-only"]) {
        expect(existsSync(join(home, tool, "skills", skill, "SKILL.md"))).toBe(true);
      }
      expect(existsSync(join(home, tool, "skills/unused"))).toBe(false);
    }
    expect(syncSkills(home, targets)).toEqual({ imported: [], linked: [], conflicts: [] });
  });

  test("links correctly into a skills folder reached through a symlink", () => {
    env = tempHome();
    const { home, write } = env;
    write(".agents/skills/used/SKILL.md", "used");
    write("seats/shared/claude/skills/used-elsewhere/.keep", "");
    write(".kiro/skills/.keep", "");
    symlinkSync("../../.agents/skills/used", join(home, ".kiro/skills/used"));
    write(".claude/.keep", "");
    symlinkSync("../seats/shared/claude/skills", join(home, ".claude/skills"));

    syncSkills(home, targets);
    expect(readFileSync(join(home, ".claude/skills/used/SKILL.md"), "utf8")).toBe("used");
    expect(syncSkills(home, targets).conflicts).toEqual([]);
  });

  test("reports a same-name skill instead of replacing it", () => {
    env = tempHome();
    env.write(".agents/skills/review/SKILL.md", "library");
    env.write(".claude/skills/review/SKILL.md", "local");
    const report = syncSkills(env.home, targets);
    expect(report.conflicts).toEqual(["claude: review"]);
    expect(readFileSync(join(env.home, ".claude/skills/review/SKILL.md"), "utf8")).toBe("local");
  });

  test("dry run plans links for skills it would import", () => {
    env = tempHome();
    env.write(".codex/skills/new/SKILL.md", "new");
    env.write(".kiro/skills/.keep", "");
    const report = syncSkills(env.home, targets, { dryRun: true });
    expect(report.imported).toEqual(["new"]);
    expect(report.linked).toEqual(["claude: new", "kiro: new"]);
    expect(existsSync(join(env.home, ".agents"))).toBe(false);
  });
});
