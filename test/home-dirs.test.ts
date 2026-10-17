import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { discoverSeatDirs, isIgnoredAccountDir, labelFromDirName } from "../src/home-dirs.ts";
import { tempHome } from "./helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

describe("labelFromDirName", () => {
  test("maps primary and secondary", () => {
    expect(labelFromDirName(".claude-primary", ".claude")).toBe("Primary");
    expect(labelFromDirName(".claude-secondary", ".claude")).toBe("Secondary");
  });

  test("title-cases named seats", () => {
    expect(labelFromDirName(".claude-work-team", ".claude")).toBe("Work Team");
    expect(labelFromDirName(".claude-side_project", ".claude")).toBe("Side Project");
    expect(labelFromDirName("personal", "")).toBe("Personal");
  });

  test("treats the live dir as Default", () => {
    expect(labelFromDirName(".claude", ".claude")).toBe("Default");
    expect(labelFromDirName(".codex", ".codex")).toBe("Default");
  });
});

describe("isIgnoredAccountDir", () => {
  test("skips backups and stubs", () => {
    expect(isIgnoredAccountDir(".claude-primary.stub-20260101")).toBe(true);
    expect(isIgnoredAccountDir(".claude-secondary.lock")).toBe(true);
    expect(isIgnoredAccountDir(".claude-work-team")).toBe(false);
  });
});

describe("discoverSeatDirs", () => {
  test("prefers the store over legacy folders with the same slug", () => {
    env = tempHome();
    const { home, write } = env;
    write(".config/seats/claude/work/.claude.json", "{}");
    write(".claude-work/.claude.json", "{}");
    write(".claude-personal/.claude.json", "{}");
    write(".claude-personal.stub-20260101/.claude.json", "{}");

    const dirs = discoverSeatDirs(home, "claude", ".claude");
    expect(dirs).toEqual([
      { dir: join(home, ".config/seats/claude/work"), slug: "work", label: "Work" },
      { dir: join(home, ".claude-personal"), slug: "personal", label: "Personal" },
    ]);
  });
});
