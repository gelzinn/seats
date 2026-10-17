import type { McpServer } from "./types.ts";

export type Json = Record<string, unknown>;

export function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

export function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === "string");
  return list.length > 0 ? list : undefined;
}

export function stringMap(value: unknown): Record<string, string> | undefined {
  const entries = Object.entries(record(value)).filter(([, v]) => typeof v === "string");
  return entries.length > 0 ? (Object.fromEntries(entries) as Record<string, string>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Drops undefined fields so written configs stay minimal. */
export function compact<T extends Json>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Reads the common `{ command, args, env } | { url, headers }` shape used by
 * Claude, Cursor, Kiro, Copilot and others. `urlKeys` lists the field names a
 * tool uses for the URL; `type` falls back to stdio/http from the fields.
 */
export function fromCommon(raw: unknown, urlKeys = ["url"]): McpServer | undefined {
  const entry = record(raw);
  const command = text(entry.command);
  const urlKey = urlKeys.find((key) => text(entry[key]));
  const url = urlKey ? text(entry[urlKey]) : undefined;
  if (!command && !url) return undefined;

  const declared = text(entry.type);
  const type: McpServer["type"] = command
    ? "stdio"
    : declared === "sse"
      ? "sse"
      : "http";

  return compact({
    type,
    command,
    args: strings(entry.args),
    env: stringMap(entry.env),
    cwd: text(entry.cwd),
    url,
    headers: stringMap(entry.headers),
  });
}
