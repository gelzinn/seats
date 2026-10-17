import { commonShape, configFile, jsonMcp } from "../../mcp/json.ts";
import { kiroHome } from "./paths.ts";

/** `~/.kiro/settings/mcp.json` → `mcpServers`. */
export const kiroMcp = jsonMcp({
  file: (home) => configFile(kiroHome(home), "settings", "mcp.json"),
  toTool: (server) => commonShape(server),
});
