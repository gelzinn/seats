import { commonShape, configFile, jsonMcp } from "../../mcp/json.ts";

/** `~/.cursor/mcp.json` → `mcpServers`, shared by the IDE and the CLI. */
export const cursorMcp = jsonMcp({
  file: (home) => configFile(home, ".cursor", "mcp.json"),
  toTool: (server) => commonShape(server),
});
