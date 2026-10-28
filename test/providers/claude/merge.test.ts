import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeClaudeConfigs, mergeClaudeState } from "../../../src/providers/claude/merge.ts";
import { tempHome } from "../../helpers/temp-home.ts";

describe("mergeClaudeState", () => {
  test("doesn't copy servers the target keeps out, in any case", () => {
    const target = { mcpServers: { docs: { type: "http" } } };
    const source = { mcpServers: { Gmail: { type: "stdio" }, search: { type: "http" } } };
    const merged = mergeClaudeState(target, [source], ["gmail"])!;
    expect(Object.keys(merged.mcpServers as object)).toEqual(["docs", "search"]);
    expect(mergeClaudeState(target, [{ mcpServers: { gmail: {} } }], ["gmail"])).toBeUndefined();
  });

  test("ORs trust flags and unions approvals", () => {
    const target = {
      oauthAccount: { emailAddress: "b@example.com" },
      projects: {
        "/work": { hasTrustDialogAccepted: false, allowedTools: ["Bash(ls)"], lastCost: 3 },
      },
    };
    const source = {
      oauthAccount: { emailAddress: "a@example.com" },
      projects: {
        "/work": { hasTrustDialogAccepted: true, allowedTools: ["Bash(git status)"], lastCost: 9 },
        "/home": { hasTrustDialogAccepted: true, lastSessionId: "abc" },
      },
    };

    const merged = mergeClaudeState(target, [source])!;
    expect(merged.oauthAccount).toEqual({ emailAddress: "b@example.com" });
    expect(merged.projects).toEqual({
      "/work": {
        hasTrustDialogAccepted: true,
        allowedTools: ["Bash(ls)", "Bash(git status)"],
        lastCost: 3,
      },
      "/home": { hasTrustDialogAccepted: true },
    });
  });

  test("never revokes and keeps disabled .mcp.json servers disabled", () => {
    const target = {
      projects: { "/p": { hasTrustDialogAccepted: true, disabledMcpjsonServers: ["db"] } },
    };
    const source = {
      projects: { "/p": { hasTrustDialogAccepted: false, enabledMcpjsonServers: ["db", "docs"] } },
    };
    const merged = mergeClaudeState(target, [source])!;
    expect(merged.projects).toEqual({
      "/p": {
        hasTrustDialogAccepted: true,
        disabledMcpjsonServers: ["db"],
        enabledMcpjsonServers: ["docs"],
      },
    });
  });

  test("adds missing user MCP servers without overriding existing ones", () => {
    const merged = mergeClaudeState({ mcpServers: { sentry: { type: "http", url: "mine" } } }, [
      { mcpServers: { sentry: { type: "http", url: "theirs" }, docs: { type: "stdio" } } },
    ])!;
    expect(merged.mcpServers).toEqual({
      sentry: { type: "http", url: "mine" },
      docs: { type: "stdio" },
    });
  });

  test("returns undefined when nothing changes", () => {
    const config = { projects: { "/p": { hasTrustDialogAccepted: true } } };
    expect(mergeClaudeState(config, [config, {}])).toBeUndefined();
  });
});

describe("mergeClaudeConfigs", () => {
  let env: ReturnType<typeof tempHome>;
  afterEach(() => env.cleanup());

  /** Three seats, each trusting its own folder and holding its own MCP server. */
  function threeSeats(): Record<"a" | "b" | "c", string> {
    env = tempHome();
    const dirs = { a: "", b: "", c: "" };
    for (const name of ["a", "b", "c"] as const) {
      env.write(`seats/${name}/.claude.json`, {
        projects: { [`/${name}`]: { hasTrustDialogAccepted: true } },
        mcpServers: { [name]: { type: "http" } },
      });
      dirs[name] = join(env.home, "seats", name);
    }
    return dirs;
  }
  const read = (dir: string) => JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));

  test("a seat that keeps its own trust neither gives nor gets projects, but still shares servers", () => {
    const { a, b, c } = threeSeats();
    mergeClaudeConfigs([a, b, c], { ownTrust: (dir) => dir === c });

    expect(Object.keys(read(a).projects).sort()).toEqual(["/a", "/b"]);
    expect(Object.keys(read(b).projects).sort()).toEqual(["/a", "/b"]);
    expect(Object.keys(read(c).projects)).toEqual(["/c"]);
    for (const dir of [a, b, c]) expect(Object.keys(read(dir).mcpServers).sort()).toEqual(["a", "b", "c"]);
  });

  test("writes only the targets, from every seat", () => {
    const { a, b, c } = threeSeats();
    const before = readFileSync(join(a, ".claude.json"), "utf8");
    expect(mergeClaudeConfigs([a, b, c], { targets: [b] })).toEqual([join(b, ".claude.json")]);

    expect(Object.keys(read(b).projects).sort()).toEqual(["/a", "/b", "/c"]);
    expect(readFileSync(join(a, ".claude.json"), "utf8")).toBe(before);
    expect(Object.keys(read(c).projects)).toEqual(["/c"]);
  });
});
