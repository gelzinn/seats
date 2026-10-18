import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { libraryFile, readLibrary, syncMcp } from "../../src/mcp/library.ts";
import { mcpAdapters } from "../../src/providers/index.ts";
import { tempHome } from "../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

const adapters = mcpAdapters.filter((adapter) => ["codex", "cursor", "opencode"].includes(adapter.id));

describe("syncMcp", () => {
  test("carries servers between tools in each tool's format", () => {
    env = tempHome();
    const { home, write } = env;
    write(".cursor/mcp.json", {
      mcpServers: {
        docs: { command: "npx", args: ["-y", "docs-mcp"], env: { TOKEN: "t" } },
        sentry: { url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "Bearer x" } },
      },
    });
    write(".codex/config.toml", 'model = "gpt"\n\n[mcp_servers.local]\ncommand = "local-mcp"\n');
    write(".config/opencode/opencode.json", { $schema: "https://opencode.ai/config.json" });

    const report = syncMcp(home, { adapters });
    expect(report.imported.sort()).toEqual(["docs", "local", "sentry"]);

    const codex = Bun.TOML.parse(readFileSync(join(home, ".codex/config.toml"), "utf8")) as {
      model?: string;
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    expect(codex.model).toBe("gpt");
    expect(codex.mcp_servers.docs).toEqual({ command: "npx", args: ["-y", "docs-mcp"], env: { TOKEN: "t" } });
    expect(codex.mcp_servers.sentry).toEqual({
      url: "https://mcp.sentry.dev/mcp",
      http_headers: { Authorization: "Bearer x" },
    });

    const opencode = JSON.parse(readFileSync(join(home, ".config/opencode/opencode.json"), "utf8"));
    expect(opencode.$schema).toBe("https://opencode.ai/config.json");
    expect(opencode.mcp.docs).toEqual({
      type: "local",
      command: ["npx", "-y", "docs-mcp"],
      environment: { TOKEN: "t" },
      enabled: true,
    });
    expect(opencode.mcp.local).toEqual({ type: "local", command: ["local-mcp"], enabled: true });

    const cursor = JSON.parse(readFileSync(join(home, ".cursor/mcp.json"), "utf8"));
    expect(cursor.mcpServers.local).toEqual({ command: "local-mcp" });

    expect(syncMcp(home, { adapters })).toEqual({ imported: [], added: [], warnings: [], failed: [] });
  });

  test("never rewrites a name the tool already has, even one it can't parse", () => {
    env = tempHome();
    const { home, write } = env;
    write(".cursor/mcp.json", { mcpServers: { docs: { command: "npx" } } });
    write(".codex/config.toml", "[mcp_servers.docs]\nsomething_new = true\n");

    const report = syncMcp(home, { adapters });
    expect(report.added).not.toContain("codex: docs");
    expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toBe("[mcp_servers.docs]\nsomething_new = true\n");
  });

  test("treats names that differ only in case as the same server", () => {
    env = tempHome();
    const { home, write } = env;
    write(".cursor/mcp.json", {
      mcpServers: { Atlassian: { url: "https://a" }, atlassian: { url: "https://b" } },
    });
    write(".config/opencode/opencode.json", {});

    syncMcp(home, { adapters });
    const opencode = JSON.parse(readFileSync(join(home, ".config/opencode/opencode.json"), "utf8"));
    expect(Object.keys(opencode.mcp)).toEqual(["Atlassian"]);
  });

  test("skip keeps a server out, and skip ['*'] keeps it out everywhere", () => {
    env = tempHome();
    const { home, write } = env;
    write(".cursor/mcp.json", { mcpServers: {} });
    write(".codex/config.toml", "");
    write(".config/seats/shared/mcp.json", {
      mcpServers: {
        removed: { type: "http", url: "https://gone", skip: ["*"] },
        notCodex: { type: "stdio", command: "x", skip: ["codex"] },
        stream: { type: "sse", url: "https://sse" },
      },
    });

    const report = syncMcp(home, { adapters });
    expect(report.added.sort()).toEqual(["cursor: notCodex", "cursor: stream"]);
  });

  test("dry run reports the plan and writes nothing", () => {
    env = tempHome();
    const { home, write } = env;
    write(".cursor/mcp.json", { mcpServers: { docs: { command: "npx" } } });
    write(".config/opencode/opencode.json", {});

    const report = syncMcp(home, { adapters, dryRun: true });
    expect(report.added).toEqual(["opencode: docs"]);
    expect(existsSync(libraryFile(home))).toBe(false);
    expect(readFileSync(join(home, ".config/opencode/opencode.json"), "utf8")).toBe("{}");
    expect(readLibrary(home)).toEqual({});
  });

  test("keeps a tool's internal servers out of other tools", () => {
    env = tempHome();
    env.write(".codex/config.toml", '[mcp_servers.node_repl]\ncommand = "node"\n');
    env.write(".cursor/mcp.json", {});
    const report = syncMcp(env.home, { adapters });
    expect(report.added).toEqual([]);
    expect(readLibrary(env.home).node_repl?.skip).toEqual(["*"]);
  });

  test("warns about Codex credentials other tools can't use", () => {
    env = tempHome();
    env.write(".codex/config.toml", '[mcp_servers.api]\nurl = "https://x"\nbearer_token_env_var = "API_TOKEN"\n');
    expect(syncMcp(env.home, { adapters, dryRun: true }).warnings).toEqual(["codex: api (credentials stay in codex)"]);
  });
});
