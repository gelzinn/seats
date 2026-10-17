import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { instructionsFile, syncInstructions, type InstructionsTarget } from "../src/instructions.ts";
import { tempHome } from "./helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

const at = (...parts: string[]) => (home: string) => join(home, ...parts);

describe("syncInstructions", () => {
  const targets: InstructionsTarget[] = [
    { id: "claude", file: at(".claude/CLAUDE.md") },
    { id: "codex", file: at(".codex/AGENTS.md") },
    { id: "gemini", file: at(".gemini/GEMINI.md") },
    { id: "copilot", file: at(".copilot/copilot-instructions.md") },
  ];

  test("links matching and empty files, leaves different text alone", () => {
    env = tempHome();
    const { home, write } = env;
    write(".claude/CLAUDE.md", "<!-- imported -->\n# Rules\n");
    write(".codex/AGENTS.md", "# Rules\n");
    write(".gemini/GEMINI.md", "");
    write(".copilot/copilot-instructions.md", "# Other\n");

    const report = syncInstructions(home, targets);

    expect(report).toEqual({ linked: ["claude", "codex", "gemini"], conflicts: ["copilot"] });
    const canonical = instructionsFile(home);
    expect(readFileSync(canonical, "utf8")).toContain("# Rules");
    for (const file of [".claude/CLAUDE.md", ".codex/AGENTS.md", ".gemini/GEMINI.md"]) {
      expect(lstatSync(join(home, file)).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(home, file), "utf8")).toContain("# Rules");
    }
    expect(readFileSync(join(home, ".copilot/copilot-instructions.md"), "utf8")).toBe("# Other\n");
    expect(syncInstructions(home, targets)).toEqual({ linked: [], conflicts: ["copilot"] });
  });

  test("handles a file reached through a seat symlink at its real path", () => {
    env = tempHome();
    const { home, write } = env;
    write("shared/claude/CLAUDE.md", "# Rules\n");
    write(".claude/.keep", "");
    symlinkSync("../shared/claude/CLAUDE.md", join(home, ".claude/CLAUDE.md"));

    syncInstructions(home, targets.slice(0, 1));

    expect(readlinkSync(join(home, ".claude/CLAUDE.md"))).toBe("../shared/claude/CLAUDE.md");
    expect(lstatSync(join(home, "shared/claude/CLAUDE.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).toBe("# Rules\n");
  });
});
