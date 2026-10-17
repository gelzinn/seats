import { commonShape, configFile, jsonMcp } from "../../mcp/json.ts";
import { copilotHome } from "./paths.ts";

/** `~/.copilot/mcp-config.json` → `mcpServers`. */
export const copilotMcp = jsonMcp({
  file: (home) => configFile(copilotHome(home), "mcp-config.json"),
  // `tools` is required, and so is `args` for local servers.
  toTool: (server) =>
    server.type === "stdio"
      ? { ...commonShape(server), type: "local", args: server.args ?? [], tools: ["*"] }
      : { ...commonShape(server, { typed: true }), tools: ["*"] },
});
