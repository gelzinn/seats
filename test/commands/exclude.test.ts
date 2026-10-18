import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { excludeItem, excludeMcp, includeItem, includeMcp, listExclusions } from "../../src/commands/exclude.ts";
import { installMcp, uninstallMcp } from "../../src/commands/install.ts";
import { syncAll, syncSeats } from "../../src/commands/sync.ts";
import { readLibrary } from "../../src/mcp/library.ts";
import type { McpServer } from "../../src/mcp/types.ts";
import { readConfig } from "../../src/store.ts";
import { tempHome } from "../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

const GMAIL: McpServer = { type: "stdio", command: "npx", args: ["gmail-mcp"] };
const RULES = "Personal rules\n";

const seat = (name: string) => join(env.home, ".config/seats/claude", name);
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** Points `~/.claude` and `~/.claude.json` at a seat, as `seats use` does. */
function activate(name: string): void {
  for (const live of [".claude", ".claude.json"]) {
    const path = join(env.home, live);
    if (existsSync(path)) unlinkSync(path);
  }
  symlinkSync(seat(name), join(env.home, ".claude"));
  symlinkSync(join(seat(name), ".claude.json"), join(env.home, ".claude.json"));
}

/**
 * Two Claude seats, `personal` and `acme`, sharing a CLAUDE.md, a skill and a
 * Gmail MCP server after one full sync with `personal` active.
 */
function twoSeats(): string {
  env = tempHome();
  const { home, write } = env;
  write(".config/seats/claude/personal/.claude.json", { mcpServers: { gmail: GMAIL } });
  write(".config/seats/claude/personal/CLAUDE.md", RULES);
  write(".config/seats/claude/personal/skills/mine/SKILL.md", "mine");
  write(".config/seats/claude/acme/.claude.json", { userID: "acme" });
  activate("personal");
  syncAll(home);
  return home;
}

describe("excludeItem", () => {
  test("replaces the seat's link with a copy, and sync leaves it alone", () => {
    const home = twoSeats();
    const path = join(seat("acme"), "CLAUDE.md");
    expect(lstatSync(path).isSymbolicLink()).toBe(true);

    expect(excludeItem(home, "claude:acme", "CLAUDE.md")).toEqual({ status: "copied", path });
    expect(lstatSync(path).isFile()).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(RULES);
    expect(readConfig(home).exclude).toEqual({ "claude:acme": ["CLAUDE.md"] });

    writeFileSync(path, "Acme rules\n");
    syncSeats(home);
    expect(lstatSync(path).isFile()).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("Acme rules\n");
    expect(readFileSync(join(seat("personal"), "CLAUDE.md"), "utf8")).toBe(RULES);
    expect(excludeItem(home, "claude:acme", "CLAUDE.md").status).toBe("already");
  });

  test("copies the shared item when ~/.config is a symlink to a folder at another depth", () => {
    env = tempHome();
    const { home, write } = env;
    // A dotfiles-managed ~/.config: links seats makes are relative to the real seat folder.
    mkdirSync(join(home, "dotfiles/deep/config"), { recursive: true });
    symlinkSync(join(home, "dotfiles/deep/config"), join(home, ".config"));
    write(".config/seats/claude/personal/CLAUDE.md", RULES);
    write(".config/seats/claude/acme/.claude.json", {});
    syncSeats(home);
    const path = join(seat("acme"), "CLAUDE.md");
    expect(lstatSync(path).isSymbolicLink()).toBe(true);

    expect(excludeItem(home, "claude:acme", "CLAUDE.md").status).toBe("copied");
    expect(lstatSync(path).isFile()).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(RULES);
  });

  test("keeps CLAUDE.md out of the full sync while that seat is active, even with the same text", () => {
    const home = twoSeats();
    excludeItem(home, "claude:acme", "CLAUDE.md");
    activate("acme");

    const report = syncAll(home);
    const path = join(seat("acme"), "CLAUDE.md");
    expect(lstatSync(path).isFile()).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(RULES);
    expect(report.instructions.linked).not.toContain("claude");
  });

  test("keeps skills out of the full sync while that seat is active", () => {
    const home = twoSeats();
    excludeItem(home, "claude:acme", "skills");
    const skills = join(seat("acme"), "skills");
    expect(lstatSync(skills).isDirectory()).toBe(true);
    // The copied link into the library still resolves.
    expect(readFileSync(join(skills, "mine/SKILL.md"), "utf8")).toBe("mine");

    activate("acme");
    env.write(".kiro/skills/other/SKILL.md", "other");
    const report = syncAll(home);

    expect(report.skills.linked).not.toContain("claude: other");
    expect(existsSync(join(skills, "other"))).toBe(false);
    expect(lstatSync(skills).isDirectory()).toBe(true);
  });

  test("activation leaves the item alone too", () => {
    const home = twoSeats();
    excludeItem(home, "claude:acme", "settings.json");
    writeFileSync(join(seat("acme"), "settings.json"), '{"model":"acme"}\n');
    syncSeats(home, ["claude"]);
    expect(lstatSync(join(seat("acme"), "settings.json")).isFile()).toBe(true);
    expect(existsSync(join(home, ".config/seats/shared/claude/settings.json"))).toBe(false);
  });
});

describe("includeItem", () => {
  test("backs the seat's copy up and links it to the shared one again, without merging", () => {
    const home = twoSeats();
    const path = join(seat("acme"), "CLAUDE.md");
    excludeItem(home, "claude:acme", "CLAUDE.md");
    writeFileSync(path, "Acme rules\n");

    expect(includeItem(home, "claude:acme", "CLAUDE.md")).toEqual({
      path,
      backup: `${path}.seats-backup`,
      linked: true,
    });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(RULES);
    expect(readFileSync(`${path}.seats-backup`, "utf8")).toBe("Acme rules\n");
    expect(readConfig(home).exclude).toBeUndefined();
    expect(() => includeItem(home, "claude:acme", "CLAUDE.md")).toThrow("already shares CLAUDE.md");
  });
});

describe("excludeMcp", () => {
  test("removes the server from the seat and the full sync doesn't bring it back", () => {
    const home = twoSeats();
    const acme = join(seat("acme"), ".claude.json");
    expect(json(acme).mcpServers.gmail).toBeDefined();

    expect(excludeMcp(home, "claude:acme", "Gmail")).toEqual({ name: "gmail", status: "removed", file: acme });
    expect(json(acme).mcpServers.gmail).toBeUndefined();
    expect(readLibrary(home).gmail?.skip).toEqual(["claude:acme"]);

    // Sync with the other seat active merges seats; with this one active it writes ~/.claude.json.
    syncAll(home);
    expect(json(acme).mcpServers.gmail).toBeUndefined();
    activate("acme");
    const report = syncAll(home);
    expect(report.mcp.added).not.toContain("claude: gmail");
    expect(json(acme).mcpServers.gmail).toBeUndefined();
    expect(json(join(seat("personal"), ".claude.json")).mcpServers.gmail).toBeDefined();
    expect(listExclusions(home, "claude:acme")).toEqual({ items: [], mcp: ["gmail"] });
  });

  test("seats install leaves the seat out, even with --force and after an uninstall", () => {
    const home = twoSeats();
    const acme = join(seat("acme"), ".claude.json");
    excludeMcp(home, "claude:acme", "gmail");
    activate("acme");

    const replaced = { ...GMAIL, args: ["gmail-mcp", "--v2"] };
    installMcp(home, "gmail", replaced, { force: true });
    expect(json(acme).mcpServers.gmail).toBeUndefined();
    expect(json(join(seat("personal"), ".claude.json")).mcpServers.gmail.args).toEqual(["gmail-mcp", "--v2"]);

    uninstallMcp(home, "gmail");
    expect(readLibrary(home).gmail?.skip).toEqual(["*", "claude:acme"]);
    const outcomes = installMcp(home, "gmail", GMAIL);
    expect(outcomes.find((outcome) => outcome.where === "claude")?.status).toBe("added");
    expect(json(acme).mcpServers.gmail).toBeUndefined();
    expect(json(join(seat("personal"), ".claude.json")).mcpServers.gmail).toBeDefined();
  });

  test("records a server only that seat has, so merging can't bring it back", () => {
    const home = twoSeats();
    const acme = join(seat("acme"), ".claude.json");
    env.write(".config/seats/claude/acme/.claude.json", { mcpServers: { client: { type: "http", url: "https://x" } } });

    excludeMcp(home, "claude:acme", "client");
    expect(readLibrary(home).client).toEqual({ type: "http", url: "https://x", skip: ["claude:acme"] });
    syncSeats(home, ["claude"]);
    expect(json(acme).mcpServers.client).toBeUndefined();
  });

  test("include lets the next sync add it back", () => {
    const home = twoSeats();
    const acme = join(seat("acme"), ".claude.json");
    excludeMcp(home, "claude:acme", "gmail");

    expect(includeMcp(home, "claude:acme", "GMAIL")).toBe("gmail");
    expect(readLibrary(home).gmail?.skip).toBeUndefined();
    syncSeats(home, ["claude"]);
    expect(json(acme).mcpServers.gmail).toBeDefined();
    expect(() => includeMcp(home, "claude:acme", "gmail")).toThrow("doesn't keep out");
  });
});

describe("validation", () => {
  test("an unknown seat, item or MCP server is an error that lists the valid ones", () => {
    const home = twoSeats();
    expect(() => excludeItem(home, "claude:nope", "CLAUDE.md")).toThrow(
      "No seat named claude:nope. Seats: claude:acme, claude:personal.",
    );
    expect(() => excludeItem(home, "claude:acme", ".credentials.json")).toThrow(
      /\.credentials\.json isn't shared between claude seats\. Shared: settings\.json, CLAUDE\.md, .*skills/,
    );
    expect(() => excludeMcp(home, "claude:acme", "slack")).toThrow("No MCP server named slack. Servers: gmail.");
    expect(() => listExclusions(home, "codex:work")).toThrow("No seat named codex:work");
    expect(readConfig(home).exclude).toBeUndefined();
  });

  test("per-seat MCP servers need a tool whose seats keep their own MCP file", () => {
    env = tempHome();
    env.write(".config/seats/codex/work/auth.json", "{}");
    env.write(".config/seats/codex/home/auth.json", "{}");
    expect(() => excludeMcp(env.home, "codex:work", "docs")).toThrow("codex seats share one MCP config");
  });
});
