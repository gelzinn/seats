import { existsSync } from "node:fs";
import { join } from "node:path";
import { discoverSeatDirs } from "../../home-dirs.ts";
import { commonShape, jsonMcp, readJson } from "../../mcp/json.ts";
import type { McpConfig } from "../../mcp/types.ts";

/** Seats skip a `.claude.json` that doesn't parse, as merging them does. */
function parses(file: string): boolean {
  try {
    readJson(file);
    return true;
  } catch {
    return false;
  }
}

/** `~/.claude.json` → `mcpServers`. */
export const claudeMcp: McpConfig = {
  ...jsonMcp({
    // ~/.claude.json sits in HOME itself, so look for ~/.claude to tell whether Claude Code is installed.
    file: (home) => (existsSync(join(home, ".claude")) ? join(home, ".claude.json") : undefined),
    // A remote entry without `type` is rejected; `cwd` isn't documented.
    toTool: (server) => commonShape(server, { typed: true, cwd: false }),
  }),
  // Every seat keeps its own `.claude.json`, and switching merges their servers.
  seatFiles: (home) =>
    discoverSeatDirs(home, "claude", ".claude")
      .map(({ dir }) => join(dir, ".claude.json"))
      .filter((file) => existsSync(file) && parses(file)),
};
