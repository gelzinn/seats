import { describe, expect, test } from "bun:test";
import { mergeClaudeState } from "../../../src/providers/claude/merge.ts";

describe("mergeClaudeState", () => {
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
    const merged = mergeClaudeState(
      { mcpServers: { sentry: { type: "http", url: "mine" } } },
      [{ mcpServers: { sentry: { type: "http", url: "theirs" }, docs: { type: "stdio" } } }],
    )!;
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
