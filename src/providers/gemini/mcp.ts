import { compact, fromCommon, record } from "../../mcp/convert.ts";
import { commonShape, configFile, jsonMcp, readJson } from "../../mcp/json.ts";
import type { McpConfig, McpServers } from "../../mcp/types.ts";
import { geminiHome } from "./paths.ts";

const base = jsonMcp({
  file: (home) => configFile(geminiHome(home), "settings.json"),
  // `httpUrl` is streamable HTTP on every version; newer ones also take `url` + `type: "http"`.
  toTool: (server) =>
    server.type === "stdio"
      ? commonShape(server)
      : server.type === "sse"
        ? compact({ type: "sse", url: server.url, headers: server.headers })
        : compact({ httpUrl: server.url, headers: server.headers }),
});

/** `~/.gemini/settings.json` → `mcpServers`. */
export const geminiMcp: McpConfig = {
  ...base,
  read(file) {
    const servers: McpServers = {};
    for (const [name, raw] of Object.entries(record(readJson(file).mcpServers))) {
      const entry = record(raw);
      const server = fromCommon(raw, ["httpUrl", "url"]);
      if (!server) continue;
      // A bare `url` means SSE unless `type` says otherwise.
      if (server.type !== "stdio" && !entry.httpUrl && entry.type !== "http") server.type = "sse";
      servers[name] = server;
    }
    return servers;
  },
};
