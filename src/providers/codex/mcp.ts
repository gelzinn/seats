import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { writeTextAtomic } from "../../fs.ts";
import { fromCommon, record, type Json } from "../../mcp/convert.ts";
import { configFile } from "../../mcp/json.ts";
import type { McpConfig, McpServer, McpServers } from "../../mcp/types.ts";
import { codexHome } from "./paths.ts";
import { removeTables } from "./toml.ts";

/** Comment written above the tables seats appends. */
const MARKER = "# added by seats";

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
  const fields: Record<string, string | undefined> =
    server.type === "stdio"
      ? {
          command: tomlValue(server.command!),
          args: server.args && tomlValue(server.args),
          cwd: server.cwd && tomlValue(server.cwd),
          env: server.env && tomlTable(server.env),
        }
      : { url: tomlValue(server.url!), http_headers: server.headers && tomlTable(server.headers) };
  // Options override seats' own fields rather than repeat a key, which TOML rejects.
  for (const [key, value] of Object.entries(server.options ?? {})) {
    fields[key] = typeof value === "string" || Array.isArray(value) ? tomlValue(value) : String(value);
  }
  const lines = Object.entries(fields).flatMap(([key, value]) => (value === undefined ? [] : [`${tomlKey(key)} = ${value}`]));
  return [`[mcp_servers.${tomlKey(name)}]`, ...lines].join("\n");
}

/** A parsed config without `names`, and without `mcp_servers` once it's empty. */
function withoutServers(config: Json, names: string[]): Json {
  const { mcp_servers, ...rest } = config;
  const remaining = { ...record(mcp_servers) };
  for (const name of names) delete remaining[name];
  return Object.keys(remaining).length > 0 ? { ...rest, mcp_servers: remaining } : rest;
}

/**
 * `~/.codex/config.toml` → `[mcp_servers.<name>]`. Servers are appended and
 * removed as text, so the rest of the file (comments, formatting) is never rewritten.
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
    appendFileSync(file, `${gap}${MARKER}\n${tables.join("\n\n")}\n`);
  },
  remove(file, names) {
    if (!existsSync(file)) return;
    const before = readFileSync(file, "utf8");
    const expected = withoutServers(record(Bun.TOML.parse(before)), names);
    const after = removeTables(
      before,
      (key) => key[0] === "mcp_servers" && key.length > 1 && names.includes(key[1]!),
      { marker: MARKER },
    );
    // Servers written inline (`docs = { ... }` under `[mcp_servers]`) aren't tables, so
    // only write when the result parses to exactly the old config minus those servers.
    let clean = false;
    try {
      clean = Bun.deepEquals(withoutServers(record(Bun.TOML.parse(after)), []), expected);
    } catch {
      // the edit left the file unparseable
    }
    if (!clean) throw new Error(`can't remove ${names.join(", ")} safely; edit ${file} by hand`);
    if (after !== before) writeTextAtomic(file, after);
  },
};
