import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../../fs.ts";

/** Per-folder approvals kept in `.claude.json` under `projects[<path>]`. */
const TRUST_FLAGS = ["hasTrustDialogAccepted", "hasClaudeMdExternalIncludesApproved"];

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function union(base: string[], extra: string[]): string[] {
  return [...base, ...extra.filter((item) => !base.includes(item))];
}

/**
 * Carries folder trust, approved tools, approved `.mcp.json` servers and
 * user-scope MCP servers from other seats into `target`. Never revokes
 * anything and never touches account data. Returns undefined when unchanged.
 */
export function mergeClaudeState(target: Json, sources: Json[]): Json | undefined {
  const projects = { ...record(target.projects) };
  const mcpServers = { ...record(target.mcpServers) };
  let changed = false;

  for (const source of sources) {
    for (const [name, server] of Object.entries(record(source.mcpServers))) {
      if (name in mcpServers) continue;
      mcpServers[name] = server;
      changed = true;
    }

    for (const [path, value] of Object.entries(record(source.projects))) {
      const entry = record(value);
      const current = record(projects[path]);
      const next: Json = { ...current };

      for (const flag of TRUST_FLAGS) if (entry[flag] === true) next[flag] = true;

      const tools = union(strings(current.allowedTools), strings(entry.allowedTools));
      if (tools.length > 0) next.allowedTools = tools;

      const disabled = strings(current.disabledMcpjsonServers);
      const enabled = union(
        strings(current.enabledMcpjsonServers),
        strings(entry.enabledMcpjsonServers).filter((name) => !disabled.includes(name)),
      );
      if (enabled.length > 0) next.enabledMcpjsonServers = enabled;

      if (JSON.stringify(next) === JSON.stringify(current)) continue;
      projects[path] = next;
      changed = true;
    }
  }

  return changed ? { ...target, projects, mcpServers } : undefined;
}

function readConfig(path: string): Json | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Merges folder trust, approvals and user MCP servers across every seat's `.claude.json`. */
export function mergeClaudeConfigs(dirs: string[]): string[] {
  const configs = dirs
    .map((dir) => ({ file: join(dir, ".claude.json"), data: readConfig(join(dir, ".claude.json")) }))
    .filter((item): item is { file: string; data: Json } => item.data !== undefined);

  const updated: string[] = [];
  for (const config of configs) {
    const others = configs.filter((other) => other !== config).map((other) => other.data);
    const merged = mergeClaudeState(config.data, others);
    if (!merged) continue;
    writeJsonAtomic(config.file, merged);
    updated.push(config.file);
  }
  return updated;
}
