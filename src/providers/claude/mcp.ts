import { commonShape, configFile, jsonMcp } from "../../mcp/json.ts";

/** `~/.claude.json` → `mcpServers`. */
export const claudeMcp = jsonMcp({
  file: (home) => configFile(home, ".claude.json"),
  // A remote entry without `type` is rejected; `cwd` isn't documented.
  toTool: (server) => commonShape(server, { typed: true, cwd: false }),
});
