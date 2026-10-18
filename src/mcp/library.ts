import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../fs.ts";
import { mcpAdapters } from "../providers/index.ts";
import { seatsHome } from "../store.ts";
import { record } from "./convert.ts";
import type { McpAdapter, McpServer, McpServers } from "./types.ts";

export function libraryFile(home: string): string {
  return join(seatsHome(home), "shared", "mcp.json");
}

export function readLibrary(home: string): McpServers {
  const file = libraryFile(home);
  if (!existsSync(file)) return {};
  return record(record(JSON.parse(readFileSync(file, "utf8"))).mcpServers) as McpServers;
}

export type McpSyncReport = {
  imported: string[];
  /** `tool: name` for every server written (or, in a dry run, to be written) into a tool. */
  added: string[];
  /** `tool: name` for servers whose credentials may not work in the tool they were copied to. */
  warnings: string[];
  failed: string[];
};

const lower = (name: string) => name.toLowerCase();

/** The copies of `servers` handed to one tool: its `tools` entry as `options`, nobody else's. */
export function forTool(servers: McpServers, toolId: string): McpServers {
  return Object.fromEntries(
    Object.entries(servers).map(([name, { tools, options: _, ...server }]) => [
      name,
      tools?.[toolId] ? { ...server, options: tools[toolId] } : server,
    ]),
  );
}

/** `${VAR}`, `$VAR`, `{env:VAR}`: every tool spells env references differently. */
export const usesEnvRefs = (server: McpServer) =>
  Object.values({ ...server.env, ...server.headers }).some((value) => /\$\{?[A-Za-z_]|\{env:/.test(value));

/**
 * Collects user-level MCP servers from every installed tool into the shared
 * library, then adds the ones each tool is missing. Names compare
 * case-insensitively, and a name a tool already has is never touched, even
 * when seats can't parse that entry. `skip: ["*"]` keeps a server everywhere out.
 */
export function syncMcp(
  home: string,
  { dryRun = false, adapters = mcpAdapters }: { dryRun?: boolean; adapters?: McpAdapter[] } = {},
): McpSyncReport {
  const report: McpSyncReport = { imported: [], added: [], warnings: [], failed: [] };
  const library = readLibrary(home);
  const known = new Set(Object.keys(library).map(lower));

  const installed = adapters.flatMap((adapter) => {
    const file = adapter.file(home);
    if (!file) return [];
    try {
      const servers = adapter.read(file);
      const names = new Set(adapter.names(file).map(lower));
      return [{ adapter, file, servers, names, warnings: adapter.warnings?.(file) ?? [] }];
    } catch {
      report.failed.push(adapter.id);
      return [];
    }
  });

  for (const { adapter, servers, warnings } of installed) {
    for (const [name, server] of Object.entries(servers)) {
      if (known.has(lower(name))) continue;
      known.add(lower(name));
      library[name] = adapter.internal?.includes(name) ? { ...server, skip: ["*"] } : server;
      report.imported.push(name);
      if (warnings.includes(name)) report.warnings.push(`${adapter.id}: ${name} (credentials stay in ${adapter.id})`);
    }
  }
  if (report.imported.length > 0 && !dryRun) writeJsonAtomic(libraryFile(home), { mcpServers: library });

  for (const { adapter, file, names } of installed) {
    const missing = Object.fromEntries(
      Object.entries(library).filter(
        ([name, server]) =>
          !names.has(lower(name)) &&
          !server.skip?.includes("*") &&
          !server.skip?.includes(adapter.id) &&
          !adapter.unsupported?.includes(server.type),
      ),
    );
    if (Object.keys(missing).length === 0) continue;
    if (!dryRun) adapter.add(file, forTool(missing, adapter.id));
    report.added.push(...Object.keys(missing).map((name) => `${adapter.id}: ${name}`));
    for (const [name, server] of Object.entries(missing)) {
      if (usesEnvRefs(server)) report.warnings.push(`${adapter.id}: ${name} (env var syntax differs)`);
    }
  }

  return report;
}
