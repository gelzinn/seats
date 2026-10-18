import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  applyImport,
  type ExportManifest,
  MANIFEST,
  planExport,
  planImport,
  runExport,
  runImport,
  writeExport,
} from "../../src/commands/export.ts";
import { syncSeats } from "../../src/commands/sync.ts";
import { tempHome } from "../helpers/temp-home.ts";

const homes: Array<ReturnType<typeof tempHome>> = [];
afterEach(() => {
  for (const env of homes.splice(0)) env.cleanup();
});

function newHome() {
  const env = tempHome();
  homes.push(env);
  return env;
}

const TOKEN = "sk-live-abcdef123456";
/** `${NAME}`, the reference an export writes. */
const ref = (name: string) => `\${${name}}`;
const AUTH = "Bearer ghp_0123456789abcdef";

/** Exports `home` to a fresh folder and returns its path and manifest. */
function exportOf(home: string) {
  const out = join(newHome().home, "dotfiles", "seats");
  const manifest = writeExport(home, out, planExport(home));
  return { out, manifest };
}

/** Every file under `dir`, joined, to search for secrets. */
function allText(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

describe("seats export", () => {
  test("carries shared config and skills, never seat folders, backups or caches", () => {
    const { home, write } = newHome();
    write(".config/seats/claude/work/.credentials.json", { token: TOKEN });
    write(".config/seats/claude/work/history.jsonl", "{}");
    write(".config/seats/active.env", `OPENROUTER_API_KEY="${TOKEN}"\n`);
    write(".config/seats/active.json", { id: "api:openrouter" });
    write(".config/seats/shared/AGENTS.md", "Be brief.\n");
    write(".config/seats/shared/claude/agents/review.md", "review");
    write(".config/seats/shared/claude/settings.json.seats-backup", { old: true });
    write(".config/seats/shared/claude/plugins/cache/big/file.js", "x");
    write(".config/seats/shared/claude/plugins/installed_plugins.json", { plugins: {} });
    write(".config/seats/shared/gemini/trustedFolders.json", { "/somewhere": "TRUST_FOLDER" });
    write("dev/my-skill/SKILL.md", "mine");
    write(".agents/skills/review/SKILL.md", "review skill");
    symlinkSync(join(home, "dev/my-skill"), join(home, ".agents/skills/mine"));
    write(".config/seats/shared/claude/skills/.keep", "");
    symlinkSync(join(home, ".agents/skills/review"), join(home, ".config/seats/shared/claude/skills/review"));
    symlinkSync(join(home, "dev/my-skill"), join(home, ".config/seats/shared/claude/skills/elsewhere"));

    const plan = planExport(home);
    const { out, manifest } = exportOf(home);

    expect(readdirSync(out).sort()).toEqual([MANIFEST, "shared", "skills"]);
    expect(readFileSync(join(out, "shared/AGENTS.md"), "utf8")).toBe("Be brief.\n");
    expect(readFileSync(join(out, "shared/claude/agents/review.md"), "utf8")).toBe("review");
    expect(existsSync(join(out, "shared/claude/plugins/installed_plugins.json"))).toBe(true);
    expect(existsSync(join(out, "shared/claude/plugins/cache"))).toBe(false);
    expect(existsSync(join(out, "shared/claude/settings.json.seats-backup"))).toBe(false);
    expect(existsSync(join(out, "shared/gemini/trustedFolders.json"))).toBe(false);
    expect(existsSync(join(out, "active.env"))).toBe(false);
    expect(allText(out)).not.toContain(TOKEN);

    // The library comes as real files; a tool's link into it is a record, a link elsewhere is skipped.
    expect(lstatSync(join(out, "skills/mine")).isDirectory()).toBe(true);
    expect(readFileSync(join(out, "skills/mine/SKILL.md"), "utf8")).toBe("mine");
    expect(lexistsIn(out, "shared/claude/skills/review")).toBe(false);
    expect(manifest.links).toEqual([{ path: "shared/claude/skills/review", target: "skills/review" }]);
    expect(plan.skipped.some((line) => line.includes("elsewhere"))).toBe(true);
    expect(manifest.dropped).toEqual(["shared/claude/plugins/cache", "shared/gemini/trustedFolders.json"]);
  });

  test("replaces literal env and header values with references, keeping existing ones", () => {
    const { home, write } = newHome();
    write(".config/seats/shared/mcp.json", {
      mcpServers: {
        docs: { type: "http", url: "https://docs.example.com/mcp", headers: { Authorization: AUTH } },
        github: { type: "stdio", command: "gh-mcp", env: { GITHUB_TOKEN: ref("GITHUB_TOKEN"), API_KEY: TOKEN } },
      },
    });
    write(".config/seats/shared/claude/settings.json", { env: { ANTHROPIC_API_KEY: TOKEN }, model: "opus" });

    const { out, manifest } = exportOf(home);

    const mcp = JSON.parse(readFileSync(join(out, "shared/mcp.json"), "utf8"));
    expect(mcp.mcpServers.docs.headers).toEqual({ Authorization: ref("DOCS_AUTHORIZATION") });
    expect(mcp.mcpServers.github.env).toEqual({ GITHUB_TOKEN: ref("GITHUB_TOKEN"), API_KEY: ref("API_KEY") });
    // Claude doesn't expand references in settings.json `env`, so the value is dropped.
    expect(JSON.parse(readFileSync(join(out, "shared/claude/settings.json"), "utf8"))).toEqual({ model: "opus" });
    expect(allText(out)).not.toContain(TOKEN);
    expect(allText(out)).not.toContain(AUTH);

    expect(manifest.env).toEqual([
      { name: "DOCS_AUTHORIZATION", file: "shared/mcp.json" },
      { name: "GITHUB_TOKEN", file: "shared/mcp.json" },
      { name: "API_KEY", file: "shared/mcp.json" },
      { name: "ANTHROPIC_API_KEY", file: "shared/claude/settings.json", dropped: true },
    ]);
  });

  test("keeps file paths, which aren't credentials and often repeat in command", () => {
    const { home, write } = newHome();
    write(".config/seats/shared/mcp.json", {
      mcpServers: {
        repl: { type: "stdio", command: "/opt/node/bin/node repl.js", env: { NODE_PATH: "/opt/node/bin/node" } },
      },
    });
    const { out, manifest } = exportOf(home);
    const mcp = JSON.parse(readFileSync(join(out, "shared/mcp.json"), "utf8"));
    expect(mcp.mcpServers.repl.env).toEqual({ NODE_PATH: "/opt/node/bin/node" });
    expect(manifest.env).toEqual([]);
  });

  test("gives two different values the same name only once", () => {
    const { home, write } = newHome();
    write(".config/seats/shared/mcp.json", {
      mcpServers: {
        a: { type: "stdio", command: "a", env: { TOKEN: "first-secret-value" } },
        b: { type: "stdio", command: "b", env: { TOKEN: "second-secret-value" } },
      },
    });
    const { out } = exportOf(home);
    const mcp = JSON.parse(readFileSync(join(out, "shared/mcp.json"), "utf8"));
    expect(mcp.mcpServers.a.env.TOKEN).toBe(ref("TOKEN"));
    expect(mcp.mcpServers.b.env.TOKEN).toBe(ref("B_TOKEN"));
  });

  test("writes a manifest with the version, the date and the paths, and no values", () => {
    const { home, write } = newHome();
    write(".config/seats/shared/mcp.json", {
      mcpServers: { docs: { type: "stdio", command: "docs", env: { TOKEN } } },
    });
    write(".agents/skills/review/SKILL.md", "review");

    const { out, manifest } = exportOf(home);
    const onDisk = JSON.parse(readFileSync(join(out, MANIFEST), "utf8")) as ExportManifest;

    expect(onDisk).toEqual(manifest);
    expect(manifest.seats).toMatch(/^\d+\.\d+\.\d+/);
    expect(Number.isNaN(Date.parse(manifest.exportedAt))).toBe(false);
    expect(manifest.paths).toEqual(["shared/mcp.json", "skills/review/SKILL.md"]);
    expect(manifest.env).toEqual([{ name: "TOKEN", file: "shared/mcp.json" }]);
    expect(readFileSync(join(out, MANIFEST), "utf8")).not.toContain(TOKEN);
  });

  test("takes secrets and trusted projects out of the Codex config.toml", () => {
    const { home, write } = newHome();
    write(
      ".config/seats/shared/codex/config.toml",
      [
        'model = "gpt-5"',
        "",
        `[projects."${home}/work/app"]`,
        'trust_level = "trusted"',
        "",
        "[mcp_servers.docs]",
        'command = "docs-mcp"',
        "startup_timeout_sec = 30",
        "",
        "[mcp_servers.docs.env]",
        `DOCS_TOKEN = "${TOKEN}"`,
        `LOG = "${ref("LOG_LEVEL")}"`,
        "",
        "[mcp_servers.remote]",
        'url = "https://remote.example.com/mcp"',
        `bearer_token = "${TOKEN}-bearer"`,
        `http_headers = { "X-Api-Key" = "${AUTH}" }`,
        "",
      ].join("\n"),
    );

    const { out, manifest } = exportOf(home);
    const text = readFileSync(join(out, "shared/codex/config.toml"), "utf8");
    const config = Bun.TOML.parse(text) as { projects?: unknown; mcp_servers: Record<string, unknown> };

    expect(allText(out)).not.toContain(TOKEN);
    expect(allText(out)).not.toContain(AUTH);
    expect(text).toStartWith('model = "gpt-5"\n');
    expect(config.projects).toBeUndefined();
    expect(text).not.toContain(home);
    expect(config.mcp_servers.docs).toEqual({
      command: "docs-mcp",
      startup_timeout_sec: 30,
      env: { DOCS_TOKEN: ref("DOCS_TOKEN"), LOG: ref("LOG_LEVEL") },
    });
    expect(config.mcp_servers.remote).toEqual({
      url: "https://remote.example.com/mcp",
      bearer_token_env_var: "REMOTE_BEARER_TOKEN",
      env_http_headers: { "X-Api-Key": "REMOTE_X_API_KEY" },
    });
    expect(manifest.dropped).toEqual(["shared/codex/config.toml: trusted projects"]);
    expect(manifest.env.map((item) => item.name)).toEqual([
      "DOCS_TOKEN",
      "LOG_LEVEL",
      "REMOTE_BEARER_TOKEN",
      "REMOTE_X_API_KEY",
    ]);
  });

  test("stops and writes nothing when a secret survives elsewhere", () => {
    const { home, write } = newHome();
    write(".config/seats/shared/mcp.json", {
      mcpServers: { docs: { type: "stdio", command: "docs", args: ["--token", TOKEN], env: { TOKEN } } },
    });
    const out = join(newHome().home, "export");

    expect(() => writeExport(home, out, planExport(home))).toThrow(
      /secret is still in the export \(TOKEN in shared\/mcp.json\)/,
    );
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(join(out, "..")).filter((name) => name.includes("seats-"))).toEqual([]);
  });

  test("refuses a folder that isn't empty, and replaces a previous export keeping the rest", () => {
    const { home, write } = newHome();
    write(".config/seats/shared/AGENTS.md", "v1");
    const other = newHome();
    other.write("notes/todo.md", "keep me");
    expect(() => writeExport(home, join(other.home, "notes"), planExport(home))).toThrow(/isn't empty/);
    expect(() => writeExport(home, join(home, ".config/seats/out"), planExport(home))).toThrow(/overlaps/);

    const { out } = exportOf(home);
    mkdirSync(join(out, ".git"));
    write(".config/seats/shared/AGENTS.md", "v2");
    writeExport(home, out, planExport(home));
    expect(readFileSync(join(out, "shared/AGENTS.md"), "utf8")).toBe("v2");
    expect(existsSync(join(out, ".git"))).toBe(true);
  });
});

function lexistsIn(dir: string, rel: string): boolean {
  try {
    lstatSync(join(dir, rel));
    return true;
  } catch {
    return false;
  }
}

describe("seats import", () => {
  test("writes home paths as ~ and expands them on the new machine", () => {
    const old = newHome();
    old.write(".config/seats/shared/claude/settings.json", {
      statusLine: { type: "command", command: `bash ${old.home}/.config/seats/claude/work/statusline.sh` },
    });
    const { out, manifest } = exportOf(old.home);
    expect(manifest.homePaths).toEqual(["shared/claude/settings.json"]);
    expect(readFileSync(join(out, "shared/claude/settings.json"), "utf8")).toContain(
      "bash ~/.config/seats/claude/work/statusline.sh",
    );

    const { home } = newHome();
    applyImport(planImport(home, out));
    const settings = JSON.parse(readFileSync(join(home, ".config/seats/shared/claude/settings.json"), "utf8"));
    expect(settings.statusLine.command).toBe(`bash ${home}/.config/seats/claude/work/statusline.sh`);
  });

  test("adds what's missing, merges JSON with local winning, and keeps a differing file", () => {
    const old = newHome();
    old.write(".config/seats/shared/AGENTS.md", "theirs");
    old.write(".config/seats/shared/claude/settings.json", { model: "opus", theme: "dark" });
    old.write(".config/seats/shared/claude/agents/review.md", "review");
    old.write(".agents/skills/review/SKILL.md", "review skill");
    old.write(".agents/skills/plan/SKILL.md", "their plan");
    old.write(".config/seats/shared/claude/skills/.keep", "");
    symlinkSync(join(old.home, ".agents/skills/review"), join(old.home, ".config/seats/shared/claude/skills/review"));
    const { out } = exportOf(old.home);

    const { home, write } = newHome();
    write(".config/seats/shared/AGENTS.md", "mine");
    write(".config/seats/shared/claude/settings.json", { model: "sonnet" });
    write(".agents/skills/plan/SKILL.md", "my plan");

    const plan = planImport(home, out);
    applyImport(plan);

    const shared = join(home, ".config/seats/shared");
    expect(readFileSync(join(shared, "AGENTS.md"), "utf8")).toBe("mine");
    expect(readFileSync(join(shared, "AGENTS.md.seats-import"), "utf8")).toBe("theirs");
    expect(JSON.parse(readFileSync(join(shared, "claude/settings.json"), "utf8"))).toEqual({
      model: "sonnet",
      theme: "dark",
    });
    expect(readFileSync(join(shared, "claude/agents/review.md"), "utf8")).toBe("review");
    expect(readFileSync(join(home, ".agents/skills/review/SKILL.md"), "utf8")).toBe("review skill");
    expect(readFileSync(join(home, ".agents/skills/plan/SKILL.md"), "utf8")).toBe("my plan");
    expect(plan.kept).toContain("skill plan");
    expect(readlinkSync(join(shared, "claude/skills/review"))).toBe("../../../../../.agents/skills/review");
    expect(readFileSync(join(shared, "claude/skills/review/SKILL.md"), "utf8")).toBe("review skill");
  });

  test("keeps a local MCP server whose name matches ignoring case", () => {
    const old = newHome();
    old.write(".config/seats/shared/mcp.json", {
      mcpServers: {
        Docs: { type: "stdio", command: "their-docs" },
        search: { type: "stdio", command: "search" },
      },
    });
    const { out } = exportOf(old.home);

    const { home, write } = newHome();
    write(".config/seats/shared/mcp.json", { mcpServers: { docs: { type: "stdio", command: "my-docs" } } });
    const plan = planImport(home, out);
    applyImport(plan);

    const mcp = JSON.parse(readFileSync(join(home, ".config/seats/shared/mcp.json"), "utf8"));
    expect(mcp.mcpServers).toEqual({
      docs: { type: "stdio", command: "my-docs" },
      search: { type: "stdio", command: "search" },
    });
    expect(plan.kept.some((line) => line.endsWith("mcp.json: Docs"))).toBe(true);
  });

  test("a seat's own copy still wins when sync shares it afterwards", () => {
    const old = newHome();
    old.write(".config/seats/shared/claude/statusline-command.sh", "echo theirs");
    const { out } = exportOf(old.home);

    const { home, write } = newHome();
    write(".config/seats/claude/work/statusline-command.sh", "echo mine");
    write(".config/seats/claude/personal/.claude.json", "{}");
    applyImport(planImport(home, out));
    syncSeats(home, ["claude"]);

    expect(readFileSync(join(home, ".config/seats/claude/personal/statusline-command.sh"), "utf8")).toBe("echo mine");
  });

  test("skips symlinks and links leaving the export", () => {
    const old = newHome();
    old.write(".config/seats/shared/AGENTS.md", "a");
    const { out } = exportOf(old.home);
    symlinkSync("/etc/passwd", join(out, "shared/passwd"));
    const manifest = JSON.parse(readFileSync(join(out, MANIFEST), "utf8"));
    manifest.links = [{ path: "shared/../../escape", target: "skills/x" }];
    writeFileSync(join(out, MANIFEST), JSON.stringify(manifest));

    const { home } = newHome();
    const plan = planImport(home, out);
    expect(plan.skipped).toEqual(["shared/passwd", "shared/../../escape"]);
    expect(plan.links).toEqual([]);
    expect(plan.writes.map((item) => item.path)).toEqual([join(home, ".config/seats/shared/AGENTS.md")]);
  });

  test("refuses a folder without a manifest", () => {
    const { home } = newHome();
    expect(() => planImport(home, join(home, "nothing"))).toThrow(/isn't a seats export/);
  });
});

describe("--dry-run", () => {
  test("export and import write nothing", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const old = newHome();
      old.write(".config/seats/shared/AGENTS.md", "theirs");
      old.write(".config/seats/shared/mcp.json", {
        mcpServers: { docs: { type: "stdio", command: "docs", env: { SEATS_TEST_TOKEN: TOKEN } } },
      });
      const out = join(newHome().home, "export");
      runExport(old.home, out, true);
      expect(existsSync(out)).toBe(false);

      const { out: real } = exportOf(old.home);
      const { home, write } = newHome();
      write(".config/seats/shared/AGENTS.md", "mine");
      runImport(home, real, true);
      expect(readdirSync(join(home, ".config/seats/shared"))).toEqual(["AGENTS.md"]);
      expect(existsSync(join(home, ".agents"))).toBe(false);
      expect(log.mock.calls.flat().join("\n")).toContain(
        "Define these env vars, which the imported config uses: SEATS_TEST_TOKEN",
      );
    } finally {
      log.mockRestore();
    }
  });
});
