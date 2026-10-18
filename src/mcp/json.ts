import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../fs.ts";
import { compact, fromCommon, record, type Json } from "./convert.ts";
import type { McpConfig, McpServer, McpServers } from "./types.ts";

export function readJson(file: string): Json {
  return existsSync(file) ? record(JSON.parse(readFileSync(file, "utf8"))) : {};
}

/** `join(...parts)` when the folder holding the file exists (the tool is installed), else undefined. */
export function configFile(...parts: string[]): string | undefined {
  return existsSync(join(...parts.slice(0, -1))) ? join(...parts) : undefined;
}

/**
 * The `{ command, args, env, cwd } | { url, headers }` shape most tools share.
 * `typed` adds `type` (stdio / http / sse); `cwd: false` drops it for tools that don't document it.
 */
export function commonShape(server: McpServer, { typed = false, cwd = true } = {}): Json {
  return server.type === "stdio"
    ? compact({
        type: typed ? "stdio" : undefined,
        command: server.command,
        args: server.args,
        env: server.env,
        cwd: cwd ? server.cwd : undefined,
      })
    : compact({ type: typed ? server.type : undefined, url: server.url, headers: server.headers });
}

/** MCP config in a JSON file that keeps servers under one key, in the common shape. */
export function jsonMcp(options: {
  file: (home: string) => string | undefined;
  /** Key holding the servers. Defaults to `mcpServers`. */
  key?: string;
  /** Field names the tool uses for a remote URL, in order of preference. */
  urlKeys?: string[];
  toTool: (server: McpServer) => Json;
}): McpConfig {
  const key = options.key ?? "mcpServers";
  const entries = (file: string) => record(readJson(file)[key]);

  return {
    file: options.file,
    read(file) {
      const servers: McpServers = {};
      for (const [name, raw] of Object.entries(entries(file))) {
        const server = fromCommon(raw, options.urlKeys);
        if (server) servers[name] = server;
      }
      return servers;
    },
    names: (file) => Object.keys(entries(file)),
    add(file, servers) {
      const data = readJson(file);
      const current = record(data[key]);
      for (const [name, server] of Object.entries(servers)) current[name] = options.toTool(server);
      writeJsonAtomic(file, { ...data, [key]: current });
    },
    remove(file, names) {
      const data = readJson(file);
      const current = record(data[key]);
      if (!names.some((name) => Object.hasOwn(current, name))) return;
      for (const name of names) delete current[name];
      writeJsonAtomic(file, { ...data, [key]: current });
    },
  };
}
