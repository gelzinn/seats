import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fromCommon, record, type Json } from "../../mcp/convert.ts";
import { configFile } from "../../mcp/json.ts";
import type { McpConfig, McpServer, McpServers } from "../../mcp/types.ts";
import { codexHome } from "./paths.ts";

/** TOML bare key when allowed, quoted otherwise. */
const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));
/** JSON strings are valid TOML basic strings. */
const tomlValue = (value: string | string[]) =>
  Array.isArray(value) ? `[${value.map((item) => JSON.stringify(item)).join(", ")}]` : JSON.stringify(value);
const tomlTable = (map: Record<string, string>) =>
  `{ ${Object.entries(map).map(([key, value]) => `${tomlKey(key)} = ${JSON.stringify(value)}`).join(", ")} }`;

function servers(file: string): Json {
  if (!existsSync(file)) return {};
  return record(record(Bun.TOML.parse(readFileSync(file, "utf8"))).mcp_servers);
}

/** One `[mcp_servers.<name>]` table. Stdio and HTTP fields never mix, which Codex rejects. */
function toTable(name: string, server: McpServer): string {
  const lines = [`[mcp_servers.${tomlKey(name)}]`];
  if (server.type === "stdio") {
    lines.push(`command = ${tomlValue(server.command!)}`);
    if (server.args) lines.push(`args = ${tomlValue(server.args)}`);
    if (server.cwd) lines.push(`cwd = ${tomlValue(server.cwd)}`);
    if (server.env) lines.push(`env = ${tomlTable(server.env)}`);
  } else {
    lines.push(`url = ${tomlValue(server.url!)}`);
    if (server.headers) lines.push(`http_headers = ${tomlTable(server.headers)}`);
  }
  return lines.join("\n");
}

/**
 * `~/.codex/config.toml` → `[mcp_servers.<name>]`. New servers are appended as
 * text, so the rest of the file (comments, formatting) is never rewritten.
 */
export const codexMcp: McpConfig = {
  file: (home) => configFile(codexHome(home), "config.toml"),
  unsupported: ["sse"],
  // Codex's own JavaScript REPL server.
  internal: ["node_repl"],
  names: (file) => Object.keys(servers(file)),
  warnings: (file) =>
    Object.entries(servers(file))
      .filter(([, raw]) => record(raw).bearer_token_env_var || record(raw).env_http_headers)
      .map(([name]) => name),
  read(file) {
    const result: McpServers = {};
    for (const [name, raw] of Object.entries(servers(file))) {
      const entry = record(raw);
      const server = fromCommon({ ...entry, headers: entry.http_headers });
      if (server) result[name] = server;
    }
    return result;
  },
  add(file, added) {
    const tables = Object.entries(added).map(([name, server]) => toTable(name, server));
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    const gap = current === "" || current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    appendFileSync(file, `${gap}# added by seats\n${tables.join("\n\n")}\n`);
  },
};
