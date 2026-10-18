import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import {
  installMcp,
  installSkill,
  parseInstallMcp,
  uninstallMcp,
  uninstallSkill,
  type Outcome,
} from "../../src/commands/install.ts";
import { syncAll } from "../../src/commands/sync.ts";
import { readLibrary, syncMcp } from "../../src/mcp/library.ts";
import type { McpServer } from "../../src/mcp/types.ts";
import { mcpAdapters } from "../../src/providers/index.ts";
import { tempHome } from "../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

const CODEX = 'model = "gpt"\n\n# my projects\n[projects."/repo"]\ntrust_level = "trusted"\n';
const DOCS: McpServer = { type: "stdio", command: "npx", args: ["-y", "docs-mcp"], env: { TOKEN: "t" } };
const SEARCH: McpServer = {
  type: "http",
  url: "https://search.example.com/mcp",
  headers: { Authorization: "Bearer t" },
};

/** Every MCP tool seats knows, installed with a little unrelated config of its own. */
function installTools(): void {
  env.write(".claude/.keep", "");
  env.write(".claude.json", { userID: "someone" });
  env.write(".codex/config.toml", CODEX);
  env.write(".cursor/mcp.json", { mcpServers: { github: { url: "https://api.example.com/mcp" } } });
  env.write(".gemini/settings.json", { theme: "dark" });
  env.write(".gemini/config/mcp_config.json", {});
  env.write(".config/opencode/opencode.json", { $schema: "https://opencode.ai/config.json" });
  env.write(".copilot/.keep", "");
  env.write(".kiro/settings/.keep", "");
}

const read = (path: string) => readFileSync(join(env.home, path), "utf8");
const json = (path: string) => JSON.parse(read(path));
const codex = () => Bun.TOML.parse(read(".codex/config.toml")) as any;
const statuses = (outcomes: Outcome[]) => Object.fromEntries(outcomes.map((item) => [item.where, item.status]));

/** Every path under `dir` with its content, link text or "dir", to prove nothing changed. */
function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const key = relative(dir, path);
      if (entry.isSymbolicLink()) result[key] = `-> ${readlinkSync(path)}`;
      else if (entry.isDirectory()) {
        result[key] = "dir";
        walk(path);
      } else result[key] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  return result;
}

describe("installMcp", () => {
  test("writes a local server into the library and every tool, each in its own format", () => {
    env = tempHome();
    installTools();

    const outcomes = installMcp(env.home, "docs", DOCS);

    expect(statuses(outcomes)).toEqual({
      library: "added",
      claude: "added",
      codex: "added",
      cursor: "added",
      gemini: "added",
      opencode: "added",
      antigravity: "added",
      copilot: "added",
      kiro: "added",
    });
    const common = { command: "npx", args: ["-y", "docs-mcp"], env: { TOKEN: "t" } };
    expect(readLibrary(env.home).docs).toEqual(DOCS);
    expect(json(".claude.json")).toEqual({ userID: "someone", mcpServers: { docs: { type: "stdio", ...common } } });
    expect(read(".codex/config.toml").startsWith(CODEX)).toBe(true);
    expect(codex().projects).toEqual({ "/repo": { trust_level: "trusted" } });
    expect(codex().mcp_servers.docs).toEqual(common);
    expect(json(".cursor/mcp.json").mcpServers).toEqual({ github: { url: "https://api.example.com/mcp" }, docs: common });
    expect(json(".gemini/settings.json")).toEqual({ theme: "dark", mcpServers: { docs: common } });
    expect(json(".gemini/config/mcp_config.json").mcpServers.docs).toEqual(common);
    expect(json(".config/opencode/opencode.json").mcp.docs).toEqual({
      type: "local",
      command: ["npx", "-y", "docs-mcp"],
      environment: { TOKEN: "t" },
      enabled: true,
    });
    expect(json(".copilot/mcp-config.json").mcpServers.docs).toEqual({ ...common, type: "local", tools: ["*"] });
    expect(json(".kiro/settings/mcp.json").mcpServers.docs).toEqual(common);
  });

  test("writes a remote server in each tool's format", () => {
    env = tempHome();
    installTools();

    installMcp(env.home, "search", SEARCH);

    const { url, headers } = SEARCH;
    expect(json(".claude.json").mcpServers.search).toEqual({ type: "http", url, headers });
    expect(codex().mcp_servers.search).toEqual({ url, http_headers: headers });
    expect(json(".cursor/mcp.json").mcpServers.search).toEqual({ url, headers });
    expect(json(".gemini/settings.json").mcpServers.search).toEqual({ httpUrl: url, headers });
    expect(json(".gemini/config/mcp_config.json").mcpServers.search).toEqual({ serverUrl: url, headers });
    expect(json(".config/opencode/opencode.json").mcp.search).toEqual({ type: "remote", url, headers, enabled: true });
    expect(json(".copilot/mcp-config.json").mcpServers.search).toEqual({ type: "http", url, headers, tools: ["*"] });
  });

  test("skips SSE in Codex, which can't run it", () => {
    env = tempHome();
    installTools();

    const outcomes = installMcp(env.home, "stream", { type: "sse", url: "https://stream.example.com/sse" });

    expect(outcomes.find((item) => item.where === "codex")).toMatchObject({ status: "skipped", reason: "codex doesn't run sse servers" });
    expect(read(".codex/config.toml")).toBe(CODEX);
    expect(json(".gemini/settings.json").mcpServers.stream).toEqual({ type: "sse", url: "https://stream.example.com/sse" });
  });

  test("leaves a tool's own server by that name alone, unless forced", () => {
    env = tempHome();
    installTools();
    env.write(".cursor/mcp.json", { mcpServers: { Docs: { command: "old-docs" } } });
    const cursorBefore = read(".cursor/mcp.json");

    expect(statuses(installMcp(env.home, "docs", DOCS)).cursor).toBe("already there");
    expect(read(".cursor/mcp.json")).toBe(cursorBefore);

    const forced = statuses(installMcp(env.home, "docs", { type: "stdio", command: "new-docs" }, { force: true }));
    expect(forced.library).toBe("replaced");
    expect(forced.cursor).toBe("replaced");
    expect(forced.codex).toBe("replaced");
    expect(json(".cursor/mcp.json").mcpServers).toEqual({ docs: { command: "new-docs" } });
    expect(Object.keys(codex().mcp_servers)).toEqual(["docs"]);
    expect(codex().mcp_servers.docs).toEqual({ command: "new-docs" });
    expect(read(".codex/config.toml").startsWith(CODEX)).toBe(true);
  });

  test("refuses a different definition than the library's without --force, before writing anything", () => {
    env = tempHome();
    installTools();
    env.write(".config/seats/shared/mcp.json", { mcpServers: { docs: { type: "stdio", command: "old-docs" } } });
    const before = snapshot(env.home);

    expect(() => installMcp(env.home, "docs", DOCS)).toThrow("--force");
    expect(snapshot(env.home)).toEqual(before);
  });

  test("clears the uninstall mark and keeps per-tool skips", () => {
    env = tempHome();
    installTools();
    env.write(".config/seats/shared/mcp.json", {
      mcpServers: {
        docs: { ...DOCS, skip: ["*"] },
        search: { ...SEARCH, skip: ["cursor"] },
      },
    });

    expect(installMcp(env.home, "docs", DOCS)[0]).toMatchObject({ status: "added", reason: "uninstall mark cleared" });
    expect(readLibrary(env.home).docs).toEqual(DOCS);

    const search = installMcp(env.home, "search", SEARCH);
    expect(statuses(search).cursor).toBe("skipped");
    expect(json(".cursor/mcp.json").mcpServers.search).toBeUndefined();
    expect(readLibrary(env.home).search?.skip).toEqual(["cursor"]);
  });

  test("dry run reports the plan and changes nothing", () => {
    env = tempHome();
    installTools();
    const before = snapshot(env.home);

    const outcomes = installMcp(env.home, "docs", DOCS, { dryRun: true });

    expect(statuses(outcomes).codex).toBe("added");
    expect(snapshot(env.home)).toEqual(before);
  });
});

describe("uninstallMcp", () => {
  test("removes the server everywhere and keeps sync from bringing it back", () => {
    env = tempHome();
    installTools();
    installMcp(env.home, "docs", DOCS);

    const outcomes = uninstallMcp(env.home, "DOCS");

    expect(Object.values(statuses(outcomes)).every((status) => status === "removed")).toBe(true);
    expect(readLibrary(env.home).docs).toEqual({ ...DOCS, skip: ["*"] });
    expect(read(".codex/config.toml")).toBe(CODEX);
    expect(json(".cursor/mcp.json").mcpServers).toEqual({ github: { url: "https://api.example.com/mcp" } });
    expect(json(".config/opencode/opencode.json").mcp).toEqual({});

    // A tool that still has it (say, a seat that was offline) doesn't spread it again.
    env.write(".cursor/mcp.json", { mcpServers: { docs: { command: "npx" } } });
    expect(syncMcp(env.home).added).toEqual([]);
    expect(json(".gemini/settings.json").mcpServers).toEqual({});
  });

  test("removes it from every Claude seat, so switching seats doesn't merge it back", () => {
    env = tempHome();
    const adapters = mcpAdapters.filter((adapter) => adapter.id === "claude");
    env.write(".config/seats/claude/work/.claude.json", { projects: {} });
    env.write(".config/seats/claude/personal/.claude.json", { projects: {} });
    env.write(".config/seats/claude/broken/.claude.json", "{ not json");
    symlinkSync(".config/seats/claude/work", join(env.home, ".claude"));
    symlinkSync(".config/seats/claude/work/.claude.json", join(env.home, ".claude.json"));

    expect(statuses(installMcp(env.home, "docs", DOCS, { adapters })).claude).toBe("added");
    expect(json(".config/seats/claude/personal/.claude.json").mcpServers.docs).toBeDefined();
    expect(read(".config/seats/claude/broken/.claude.json")).toBe("{ not json");

    uninstallMcp(env.home, "docs", { adapters });
    syncAll(env.home);

    for (const seat of ["work", "personal"]) {
      expect(json(`.config/seats/claude/${seat}/.claude.json`).mcpServers).toEqual({});
    }
    expect(lstatSync(join(env.home, ".claude.json")).isSymbolicLink()).toBe(true);
  });

  test("tombstones a server only a tool had, and fails for one nobody has", () => {
    env = tempHome();
    installTools();
    env.write(".cursor/mcp.json", { mcpServers: { github: { url: "https://api.example.com/mcp" } } });

    expect(statuses(uninstallMcp(env.home, "github")).cursor).toBe("removed");
    expect(readLibrary(env.home).github).toEqual({ type: "http", url: "https://api.example.com/mcp", skip: ["*"] });
    expect(() => uninstallMcp(env.home, "missing")).toThrow('No MCP server named "missing"');
  });

  test("dry run changes nothing", () => {
    env = tempHome();
    installTools();
    installMcp(env.home, "docs", DOCS);
    const before = snapshot(env.home);

    expect(statuses(uninstallMcp(env.home, "docs", { dryRun: true })).codex).toBe("removed");
    expect(snapshot(env.home)).toEqual(before);
  });
});

/** Tools with a skills folder: Claude, Kiro and Antigravity get links; Codex, Cursor and Gemini read the library. */
function installSkillTools(): void {
  for (const dir of [".claude", ".kiro", ".gemini/config", ".codex", ".cursor"]) env.write(`${dir}/.keep`, "");
}

function writeSkill(dir: string, frontMatter = ""): string {
  env.write(`${dir}/SKILL.md`, `${frontMatter}# Review\n`);
  env.write(`${dir}/checklist.md`, "- tests\n");
  return join(env.home, dir);
}

describe("installSkill", () => {
  test("copies the skill into the library and links it into tools that don't read it", () => {
    env = tempHome();
    installSkillTools();
    const source = writeSkill("work/review");

    const { name, outcomes } = installSkill(env.home, source);

    expect(name).toBe("review");
    expect(statuses(outcomes)).toEqual({
      library: "added",
      claude: "linked",
      codex: "reads the library",
      cursor: "reads the library",
      gemini: "reads the library",
      antigravity: "linked",
      kiro: "linked",
    });
    expect(lstatSync(join(env.home, ".agents/skills/review")).isDirectory()).toBe(true);
    expect(read(".agents/skills/review/checklist.md")).toBe("- tests\n");
    for (const dir of [".claude/skills", ".kiro/skills", ".gemini/config/skills"]) {
      const link = join(env.home, dir, "review");
      expect(readlinkSync(link).startsWith("/")).toBe(false);
      expect(readFileSync(join(link, "SKILL.md"), "utf8")).toBe("# Review\n");
    }
    expect(existsSync(join(env.home, ".codex/skills/review"))).toBe(false);
    expect(existsSync(join(env.home, ".cursor/skills/review"))).toBe(false);
  });

  test("never replaces a tool's own folder, and replaces the library copy only with --force", () => {
    env = tempHome();
    installSkillTools();
    env.write(".kiro/skills/review/SKILL.md", "kiro's own\n");
    const source = writeSkill("work/review");
    installSkill(env.home, source);

    expect(() => installSkill(env.home, source)).toThrow("--force");
    env.write("work/review/SKILL.md", "# Review v2\n");
    const { outcomes } = installSkill(env.home, source, { force: true });

    expect(statuses(outcomes)).toMatchObject({ library: "replaced", claude: "already there", kiro: "skipped" });
    expect(read(".agents/skills/review/SKILL.md")).toBe("# Review v2\n");
    expect(read(".kiro/skills/review/SKILL.md")).toBe("kiro's own\n");
    expect(lstatSync(join(env.home, ".kiro/skills/review")).isSymbolicLink()).toBe(false);
  });

  test("names the skill from its front matter and finds it in a single subfolder", () => {
    env = tempHome();
    installSkillTools();
    writeSkill("work/pack/inner", "---\nname: review\ndescription: Reviews code\n---\n");

    expect(installSkill(env.home, join(env.home, "work/pack")).name).toBe("review");
    expect(read(".agents/skills/review/checklist.md")).toBe("- tests\n");
  });

  test("rejects folders without a skill, with several, or with an unsafe name", () => {
    env = tempHome();
    env.write("empty/notes.md", "");
    writeSkill("many/one");
    writeSkill("many/two");
    writeSkill("evil/skill", "---\nname: ../../outside\n---\n");

    expect(() => installSkill(env.home, join(env.home, "empty"))).toThrow("No SKILL.md");
    expect(() => installSkill(env.home, join(env.home, "many"))).toThrow("several skills (one, two)");
    expect(() => installSkill(env.home, join(env.home, "evil"))).toThrow("can't name a skill folder");
    expect(() => installSkill(env.home, "not-a-folder")).toThrow("isn't a folder or a git URL");
    expect(existsSync(join(env.home, ".agents"))).toBe(false);
  });

  test.skipIf(!Bun.which("git"))("clones a git repo and names the skill after it", () => {
    env = tempHome();
    installSkillTools();
    const repo = writeSkill("repos/review-skill");
    // No global or system git config: the test neither reads nor depends on the developer's.
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const identity = ["-c", "user.name=seats", "-c", "user.email=you@work.example", "-c", "commit.gpgsign=false"];
    for (const args of [["init", "-q"], ["add", "."], ["commit", "-q", "-m", "skill"]]) {
      expect(Bun.spawnSync(["git", "-C", repo, ...identity, ...args], { env: gitEnv }).exitCode).toBe(0);
    }

    const { name, outcomes } = installSkill(env.home, `file://${repo}`);

    expect(name).toBe("review-skill");
    expect(statuses(outcomes).claude).toBe("linked");
    expect(read(".agents/skills/review-skill/SKILL.md")).toBe("# Review\n");
    expect(existsSync(join(env.home, ".agents/skills/review-skill/.git"))).toBe(false);
  });

  test("dry run changes nothing", () => {
    env = tempHome();
    installSkillTools();
    const source = writeSkill("work/review");
    const before = snapshot(env.home);

    expect(statuses(installSkill(env.home, source, { dryRun: true }).outcomes).claude).toBe("linked");
    expect(snapshot(env.home)).toEqual(before);
  });
});

describe("uninstallSkill", () => {
  test("removes library links and the library copy, never a tool's own folder or other links", () => {
    env = tempHome();
    installSkillTools();
    env.write(".kiro/skills/review/SKILL.md", "kiro's own\n");
    env.write(".gemini/antigravity-cli/skills/.keep", "");
    const elsewhere = writeSkill("dotfiles/review");
    symlinkSync(elsewhere, join(env.home, ".gemini/antigravity-cli/skills/review"));
    installSkill(env.home, writeSkill("work/review"));

    const outcomes = uninstallSkill(env.home, "review");

    expect(statuses(outcomes)).toEqual({
      library: "removed",
      claude: "removed",
      codex: "reads the library",
      cursor: "reads the library",
      gemini: "reads the library",
      antigravity: "removed",
      "antigravity-cli": "skipped",
      kiro: "skipped",
    });
    expect(existsSync(join(env.home, ".agents/skills/review"))).toBe(false);
    expect(existsSync(join(env.home, ".claude/skills/review"))).toBe(false);
    expect(read(".kiro/skills/review/SKILL.md")).toBe("kiro's own\n");
    expect(readlinkSync(join(env.home, ".gemini/antigravity-cli/skills/review"))).toBe(elsewhere);
    expect(read("dotfiles/review/SKILL.md")).toBe("# Review\n");
  });

  test("finds links inside a skills folder that is itself a link, as seats sets up for seats of one tool", () => {
    env = tempHome();
    env.write(".config/seats/shared/claude/skills/.keep", "");
    env.write(".claude/.keep", "");
    symlinkSync("../.config/seats/shared/claude/skills", join(env.home, ".claude/skills"));
    installSkill(env.home, writeSkill("work/review"));
    expect(read(".config/seats/shared/claude/skills/review/SKILL.md")).toBe("# Review\n");

    expect(statuses(uninstallSkill(env.home, "review")).claude).toBe("removed");
    expect(existsSync(join(env.home, ".config/seats/shared/claude/skills/review"))).toBe(false);
  });

  test("dry run changes nothing, and an unknown skill is an error", () => {
    env = tempHome();
    installSkillTools();
    installSkill(env.home, writeSkill("work/review"));
    const before = snapshot(env.home);

    expect(statuses(uninstallSkill(env.home, "review", { dryRun: true })).library).toBe("removed");
    expect(snapshot(env.home)).toEqual(before);
    expect(() => uninstallSkill(env.home, "missing")).toThrow('No skill named "missing"');
  });
});

describe("parseInstallMcp", () => {
  test("reads a local server; the server's own args after -- stay as they are", () => {
    expect(parseInstallMcp(["docs", "--env", "TOKEN=a=b", "--dry-run", "--", "npx", "-y", "docs-mcp", "--env", "prod"])).toEqual({
      name: "docs",
      force: false,
      dryRun: true,
      server: { type: "stdio", command: "npx", args: ["-y", "docs-mcp", "--env", "prod"], env: { TOKEN: "a=b" } },
    });
    expect(parseInstallMcp(["docs", "--", "docs-mcp"]).server).toEqual({ type: "stdio", command: "docs-mcp" });
  });

  test("takes --env KEY=VALUE, --force and --dry-run at the end of the command as seats' own", () => {
    expect(
      parseInstallMcp(["docs", "--env", "A=1", "--", "npx", "-y", "docs-mcp", "--env", "B=2", "--env", "C=3", "--dry-run"]),
    ).toEqual({
      name: "docs",
      force: false,
      dryRun: true,
      server: { type: "stdio", command: "npx", args: ["-y", "docs-mcp"], env: { A: "1", B: "2", C: "3" } },
    });
    expect(parseInstallMcp(["docs", "--", "docs-mcp", "--force"]).force).toBe(true);
    expect(() => parseInstallMcp(["docs", "--", "--env", "A=1"])).toThrow("command after --");
  });

  test("reads a remote server", () => {
    expect(
      parseInstallMcp(["github", "--url", "https://api.example.com/mcp", "--header", "Authorization: Bearer t", "--sse", "--force"]),
    ).toEqual({
      name: "github",
      force: true,
      dryRun: false,
      server: { type: "sse", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer t" } },
    });
  });

  test.each([
    [[], "Name the MCP server"],
    [["my docs", "--", "npx"], "can't name an MCP server"],
    [["docs"], "command after --, or its --url"],
    [["docs", "--"], "command after --"],
    [["docs", "--url", "https://x.example", "--", "npx"], "not both"],
    [["docs", "--sse", "--", "npx"], "remote servers"],
    [["docs", "--env", "TOKEN", "--", "npx"], "Expected --env KEY=VALUE"],
    [["docs", "--url", "https://x.example", "--env", "A=b"], "--env is for local servers"],
    [["docs", "--url", "https://x.example", "--header", "NoColon"], 'Expected --header "Key: Value"'],
    [["docs", "--url", "ftp://x.example"], "isn't an http(s) URL"],
    [["docs", "--url"], "--url needs a value"],
    [["docs", "--verbose", "--", "npx"], "Unknown option --verbose"],
    [["docs", "extra", "--", "npx"], "Unexpected extra"],
  ])("rejects %j", (argv, error) => {
    expect(() => parseInstallMcp(argv as string[])).toThrow(error);
  });
});
