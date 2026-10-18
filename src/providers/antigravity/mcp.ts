import { existsSync } from "node:fs";
import { join } from "node:path";
import { compact } from "../../mcp/convert.ts";
import { commonShape, configFile, jsonMcp } from "../../mcp/json.ts";

/** `~/.gemini/config/mcp_config.json`, or the older `~/.gemini/antigravity/` copy. */
export const antigravityMcp = jsonMcp({
  file: (home) => {
    const current = join(home, ".gemini", "config", "mcp_config.json");
    return existsSync(current) ? current : configFile(home, ".gemini", "antigravity", "mcp_config.json");
  },
  // Remote servers use `serverUrl`; `url` and `httpUrl` aren't accepted.
  urlKeys: ["serverUrl", "url"],
  toTool: (server) =>
    server.type === "stdio" ? commonShape(server) : compact({ serverUrl: server.url, headers: server.headers }),
});
