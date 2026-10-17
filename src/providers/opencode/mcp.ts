import { writeJsonAtomic } from "../../fs.ts";
import { compact, record, stringMap, strings, type Json } from "../../mcp/convert.ts";
import { configFile, readJson } from "../../mcp/json.ts";
import type { McpConfig, McpServer, McpServers } from "../../mcp/types.ts";

function fromOpencode(raw: unknown): McpServer | undefined {
  const entry = record(raw);
  if (entry.type === "remote" && typeof entry.url === "string") {
    return compact({ type: "http" as const, url: entry.url, headers: stringMap(entry.headers) });
  }
  if (entry.type !== "local") return undefined;

  // Documented shape is `command: [bin, ...args]`; `command` + `args` also shows up in the wild.
  const command =
    strings(entry.command) ??
    (typeof entry.command === "string" ? [entry.command, ...(strings(entry.args) ?? [])] : undefined);
  if (!command) return undefined;
  return compact({
    type: "stdio" as const,
    command: command[0],
    args: command.length > 1 ? command.slice(1) : undefined,
    env: stringMap(entry.environment) ?? stringMap(entry.env),
  });
}

function toOpencode(server: McpServer): Json {
  return server.type === "stdio"
    ? compact({
        type: "local",
        command: [server.command!, ...(server.args ?? [])],
        environment: server.env,
        enabled: true,
      })
    : compact({ type: "remote", url: server.url, headers: server.headers, enabled: true });
}

/** `~/.config/opencode/opencode.json` → `mcp`, with `local` / `remote` entries. */
export const opencodeMcp: McpConfig = {
  file: (home) => configFile(home, ".config", "opencode", "opencode.json"),
  read(file) {
    const servers: McpServers = {};
    for (const [name, raw] of Object.entries(record(readJson(file).mcp))) {
      const server = fromOpencode(raw);
      if (server) servers[name] = server;
    }
    return servers;
  },
  names: (file) => Object.keys(record(readJson(file).mcp)),
  add(file, servers) {
    const data = readJson(file);
    const mcp = record(data.mcp);
    for (const [name, server] of Object.entries(servers)) mcp[name] = toOpencode(server);
    writeJsonAtomic(file, { ...data, mcp });
  },
};
