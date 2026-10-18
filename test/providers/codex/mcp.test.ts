import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { codexMcp } from "../../../src/providers/codex/mcp.ts";
import { tempHome } from "../../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

const CONFIG = `model = "gpt"

[projects."/repo"]
trust_level = "trusted"

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]

# GitHub tools
[mcp_servers.github]
url = "https://api.example.com/mcp"

[mcp_servers.docs.env]
TOKEN = "t"

[mcp_servers."my server"]
command = "x"
`;

describe("codexMcp.remove", () => {
  test("removes the table and its sub-tables, wherever they are, and nothing else", () => {
    env = tempHome();
    const file = env.write(".codex/config.toml", CONFIG);

    codexMcp.remove(file, ["docs"]);

    expect(readFileSync(file, "utf8")).toBe(`model = "gpt"

[projects."/repo"]
trust_level = "trusted"

# GitHub tools
[mcp_servers.github]
url = "https://api.example.com/mcp"

[mcp_servers."my server"]
command = "x"
`);
    expect(codexMcp.names(file)).toEqual(["github", "my server"]);
  });

  test("removes a quoted name, and the blank lines before a last table", () => {
    env = tempHome();
    const file = env.write(".codex/config.toml", CONFIG);
    codexMcp.remove(file, ["my server"]);
    expect(readFileSync(file, "utf8")).toBe(CONFIG.slice(0, CONFIG.indexOf('\n[mcp_servers."my server"]')));
  });

  test("undoes add byte for byte, the seats marker included", () => {
    env = tempHome();
    const original = 'model = "gpt"\n\n[projects."/repo"]\ntrust_level = "trusted"\n';
    const file = env.write(".codex/config.toml", original);

    codexMcp.add(file, { docs: { type: "stdio", command: "npx" } });
    expect(readFileSync(file, "utf8")).toContain("# added by seats");
    codexMcp.remove(file, ["docs"]);

    expect(readFileSync(file, "utf8")).toBe(original);
  });

  test("doesn't mistake brackets inside strings and arrays for tables", () => {
    env = tempHome();
    const kept = `[mcp_servers.other]
command = "y"
notes = '''
[mcp_servers.docs]
'''
`;
    const file = env.write(
      ".codex/config.toml",
      `${kept}
[mcp_servers.docs]
command = "npx"
args = [
  "-y",
  "docs-mcp",
]
notes = """
[mcp_servers.keep]
"""
`,
    );

    codexMcp.remove(file, ["docs"]);
    expect(readFileSync(file, "utf8")).toBe(kept);
  });

  test("keeps CRLF line endings", () => {
    env = tempHome();
    const file = env.write(".codex/config.toml", 'model = "gpt"\r\n\r\n[mcp_servers.docs]\r\ncommand = "x"\r\n');
    codexMcp.remove(file, ["docs"]);
    expect(readFileSync(file, "utf8")).toBe('model = "gpt"\r\n');
  });

  test("writes through a shared config.toml link", () => {
    env = tempHome();
    const shared = env.write(".config/seats/shared/codex/config.toml", CONFIG);
    env.write(".codex/.keep", "");
    const live = join(env.home, ".codex/config.toml");
    symlinkSync(shared, live);

    codexMcp.remove(live, ["github"]);

    expect(lstatSync(live).isSymbolicLink()).toBe(true);
    expect(codexMcp.names(shared)).toEqual(["docs", "my server"]);
  });

  test("refuses, and leaves the file alone, when the server isn't a table", () => {
    env = tempHome();
    const inline = '[mcp_servers]\ndocs = { command = "npx" }\n';
    const file = env.write(".codex/config.toml", inline);

    expect(() => codexMcp.remove(file, ["docs"])).toThrow("edit");
    expect(readFileSync(file, "utf8")).toBe(inline);
  });

  test("does nothing for a name the file doesn't have", () => {
    env = tempHome();
    const file = env.write(".codex/config.toml", CONFIG);
    codexMcp.remove(file, ["missing"]);
    expect(readFileSync(file, "utf8")).toBe(CONFIG);
  });
});
