import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { shareItems } from "../src/share.ts";
import { tempHome } from "./helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

function age(path: string, secondsAgo: number): void {
  const time = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, time, time);
}

describe("shareItems", () => {
  test("moves the first copy to the shared folder and links every seat", () => {
    env = tempHome();
    const { home, write } = env;
    write("a/skills/review/SKILL.md", "review");
    write("b/.claude.json", "{}");
    const seats = [join(home, "a"), join(home, "b")];
    const shared = join(home, "shared");

    shareItems(seats, shared, ["skills"]);

    expect(readFileSync(join(shared, "skills/review/SKILL.md"), "utf8")).toBe("review");
    for (const seat of seats) {
      expect(lstatSync(join(seat, "skills")).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(seat, "skills/review/SKILL.md"), "utf8")).toBe("review");
    }
  });

  test("merges folders and keeps conflicting files as backups", () => {
    env = tempHome();
    const { home, write } = env;
    write("a/agents/one.md", "one");
    write("a/agents/same.md", "x");
    write("b/agents/two.md", "two");
    write("b/agents/same.md", "y");
    age(join(home, "b/agents/same.md"), 60);
    age(join(home, "b/agents"), 60);
    const seats = [join(home, "a"), join(home, "b")];

    const report = shareItems(seats, join(home, "shared"), ["agents"]);

    expect(readdirSync(join(home, "shared/agents")).sort()).toEqual(["one.md", "same.md", "two.md"]);
    expect(report.backups).toEqual([join(home, "b/agents.seats-backup")]);
    expect(readFileSync(join(home, "b/agents.seats-backup/same.md"), "utf8")).toBe("y");
  });

  test("fills missing JSON keys from older copies", () => {
    env = tempHome();
    const { home, write } = env;
    write("a/settings.json", { model: "opus", theme: "dark" });
    const older = write("b/settings.json", { theme: "dark", statusLine: { type: "command" } });
    age(older, 60);

    const report = shareItems([join(home, "a"), join(home, "b")], join(home, "shared"), ["settings.json"]);

    expect(JSON.parse(readFileSync(join(home, "shared/settings.json"), "utf8"))).toEqual({
      theme: "dark",
      statusLine: { type: "command" },
      model: "opus",
    });
    expect(report.backups).toEqual([]);
  });

  test("merges nested JSON so a newer, emptier registry drops nothing", () => {
    env = tempHome();
    const { home, write } = env;
    const older = write("a/plugins/installed_plugins.json", {
      version: 2,
      plugins: { "atlassian@official": [{ scope: "user" }] },
    });
    age(older, 60);
    write("b/plugins/installed_plugins.json", { version: 2, plugins: { "docs@official": [] } });

    const report = shareItems([join(home, "a"), join(home, "b")], join(home, "shared"), [
      "plugins/installed_plugins.json",
    ]);

    expect(JSON.parse(readFileSync(join(home, "a/plugins/installed_plugins.json"), "utf8"))).toEqual({
      version: 2,
      plugins: { "atlassian@official": [{ scope: "user" }], "docs@official": [] },
    });
    expect(report.backups).toEqual([]);
  });

  test("relinks links into other seats but leaves user links alone", () => {
    env = tempHome();
    const { home, write } = env;
    write("a/hooks/pre.sh", "echo");
    write("dotfiles/themes/dark.json", "{}");
    write("b/.keep", "");
    symlinkSync("../a/hooks", join(home, "b/hooks"));
    symlinkSync("../dotfiles/themes", join(home, "b/themes"));
    const seats = [join(home, "a"), join(home, "b")];

    shareItems(seats, join(home, "shared"), ["hooks", "themes"]);

    expect(readFileSync(join(home, "b/hooks/pre.sh"), "utf8")).toBe("echo");
    expect(lstatSync(join(home, "b/hooks")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home, "shared/themes"))).toBe(false);
    expect(readFileSync(join(home, "b/themes/dark.json"), "utf8")).toBe("{}");
  });

  test("keeps relative links inside moved folders working", () => {
    env = tempHome();
    const { home, write } = env;
    write(".agents/skills/deslop/SKILL.md", "deslop");
    write(".agents/skills/ship/SKILL.md", "ship");
    write("seats/a/skills/local/SKILL.md", "local");
    write("seats/b/skills/other/SKILL.md", "other");
    symlinkSync("../../../.agents/skills/deslop", join(home, "seats/a/skills/deslop"));
    symlinkSync("../../../.agents/skills/ship", join(home, "seats/b/skills/ship"));
    age(join(home, "seats/b/skills"), 60);
    const seats = [join(home, "seats/a"), join(home, "seats/b")];

    shareItems(seats, join(home, "config/seats/shared/claude"), ["skills"]);

    for (const seat of seats) {
      expect(readFileSync(join(seat, "skills/deslop/SKILL.md"), "utf8")).toBe("deslop");
      expect(readFileSync(join(seat, "skills/ship/SKILL.md"), "utf8")).toBe("ship");
      expect(readFileSync(join(seat, "skills/other/SKILL.md"), "utf8")).toBe("other");
    }
  });

  test("is idempotent", () => {
    env = tempHome();
    const { home, write } = env;
    write("a/CLAUDE.md", "rules");
    const seats = [join(home, "a"), join(home, "b")];
    write("b/.keep", "");
    shareItems(seats, join(home, "shared"), ["CLAUDE.md"]);
    const again = shareItems(seats, join(home, "shared"), ["CLAUDE.md"]);
    expect(again).toEqual({ linked: [], backups: [] });
  });
});
