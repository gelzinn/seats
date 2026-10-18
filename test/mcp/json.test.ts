import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeMcp } from "../../src/providers/claude/mcp.ts";
import { cursorMcp } from "../../src/providers/cursor/mcp.ts";
import { opencodeMcp } from "../../src/providers/opencode/mcp.ts";
import { tempHome } from "../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("jsonMcp remove", () => {
  test("removes only the named servers and keeps the rest of the file", () => {
    env = tempHome();
    const file = env.write(".cursor/mcp.json", {
      other: true,
      mcpServers: { docs: { command: "npx" }, github: { url: "https://api.example.com/mcp" } },
    });

    cursorMcp.remove(file, ["docs"]);

    expect(json(file)).toEqual({ other: true, mcpServers: { github: { url: "https://api.example.com/mcp" } } });
  });

  test("leaves the file untouched when no name matches", () => {
    env = tempHome();
    const file = env.write(".cursor/mcp.json", '{"mcpServers":{"docs":{"command":"npx"}}}');
    cursorMcp.remove(file, ["constructor", "missing"]);
    expect(readFileSync(file, "utf8")).toBe('{"mcpServers":{"docs":{"command":"npx"}}}');
  });
});

describe("opencodeMcp remove", () => {
  test("removes the entry from `mcp`", () => {
    env = tempHome();
    const file = env.write(".config/opencode/opencode.json", {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        docs: { type: "local", command: ["npx"] },
        github: { type: "remote", url: "https://api.example.com/mcp" },
      },
    });

    opencodeMcp.remove(file, ["docs"]);

    expect(json(file)).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: { github: { type: "remote", url: "https://api.example.com/mcp" } },
    });
  });
});

describe("claudeMcp", () => {
  test("isn't installed without ~/.claude, so ~/.claude.json is never created for others", () => {
    env = tempHome();
    expect(claudeMcp.file(env.home)).toBeUndefined();
    env.write(".claude/settings.json", "{}");
    expect(claudeMcp.file(env.home)).toBe(join(env.home, ".claude.json"));
  });
});
