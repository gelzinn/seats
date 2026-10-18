import { cpSync, existsSync, mkdirSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { findSeatFolder, mcpKeptOut, readExclusions, type SeatFolder, seatIdOf } from "../exclude.ts";
import { isSymlink, lexists, linkTarget, moveTree, replaceSymlink, writeJsonAtomic } from "../fs.ts";
import { libraryFile, readLibrary } from "../mcp/library.ts";
import type { McpAdapter } from "../mcp/types.ts";
import { mcpAdapters, providers } from "../providers/index.ts";
import { backupPath } from "../share.ts";
import { readConfig, sharedDir, writeConfig } from "../store.ts";
import { fail, intro, tilde } from "./ui.ts";

const USAGE = `Keep a shared item or an MCP server out of one seat.

Usage:
  seats exclude <seat-id>              List what the seat keeps out
  seats exclude <seat-id> <item>       Give the seat its own copy of a shared item
  seats exclude <seat-id> mcp <name>   Keep an MCP server out of the seat
  seats include <seat-id> <item>       Link the seat to the shared copy again
  seats include <seat-id> mcp <name>   Let sync add the server back

Examples:
  seats exclude claude:acme CLAUDE.md
  seats exclude claude:acme mcp gmail
  seats include claude:acme CLAUDE.md`;

const lower = (name: string) => name.toLowerCase();

function setExclusions(home: string, id: string, items: string[]): void {
  const config = readConfig(home);
  const exclude = { ...config.exclude, [id]: items };
  if (items.length === 0) delete exclude[id];
  writeConfig(home, { ...config, exclude: Object.keys(exclude).length > 0 ? exclude : undefined });
}

/** The seat for `id`, after checking `item` is one of its source's shared items. */
function seatItem(home: string, id: string, item: string): SeatFolder & { path: string; shared: string } {
  const seat = findSeatFolder(home, id);
  const items = seat.source.sharedItems ?? [];
  if (!items.includes(item))
    throw new Error(`${item} isn't shared between ${seat.source.id} seats. Shared: ${items.join(", ")}.`);
  return { ...seat, path: join(seat.dir, item), shared: join(sharedDir(home, seat.source.id), item) };
}

export type ExcludeResult = { status: "copied" | "kept" | "already"; path: string };

/**
 * Stops sharing `item` with seat `id`. A link to the shared copy becomes a real
 * copy of it, so nothing changes until the user edits it. From then on sync
 * and activation leave the seat's item alone.
 */
export function excludeItem(home: string, id: string, item: string): ExcludeResult {
  const { path, shared } = seatItem(home, id, item);
  const current = readExclusions(home)[id] ?? [];
  if (current.includes(item)) return { status: "already", path };

  let status: ExcludeResult["status"] = "kept";
  if (isSymlink(path) && linkTarget(path) === shared) {
    if (existsSync(path)) {
      // From the real path: the shared CLAUDE.md is often a link to shared/AGENTS.md itself.
      const copy = `${path}.seats-copy-${process.pid}`;
      cpSync(realpathSync(path), copy, { recursive: true });
      unlinkSync(path);
      renameSync(copy, path);
      status = "copied";
    } else {
      unlinkSync(path);
    }
  }
  setExclusions(home, id, [...current, item]);
  return { status, path };
}

export type IncludeResult = { path: string; backup?: string; linked: boolean };

/**
 * Shares `item` with seat `id` again. The seat's own copy moves aside as
 * `<item>.seats-backup` instead of being merged, since it may hold content
 * that must not reach the other seats.
 */
export function includeItem(home: string, id: string, item: string): IncludeResult {
  const { path, shared } = seatItem(home, id, item);
  const current = readExclusions(home)[id] ?? [];
  if (!current.includes(item)) throw new Error(`${id} already shares ${item}.`);

  let backup: string | undefined;
  if (lexists(path) && !isSymlink(path)) {
    backup = backupPath(path);
    moveTree(path, backup);
  }
  const linked = lexists(shared) && !lexists(path);
  if (linked) {
    mkdirSync(dirname(path), { recursive: true });
    replaceSymlink(path, shared);
  }
  setExclusions(
    home,
    id,
    current.filter((name) => name !== item),
  );
  return { path, backup, linked };
}

/** The tool whose seats keep their own MCP file, with `seat`'s copy of it. */
function seatMcp(home: string, seat: SeatFolder): { adapter: McpAdapter; file?: string } {
  const provider = providers.find((item) => item.seats?.includes(seat.source));
  const adapter = mcpAdapters.find((item) => item.id === provider?.id && item.seatFiles);
  if (!adapter) {
    const tools = mcpAdapters.filter((item) => item.seatFiles).map((item) => item.id);
    throw new Error(`${seat.source.id} seats share one MCP config. Per-seat servers work for: ${tools.join(", ")}.`);
  }
  const file = adapter.seatFiles!(home).find((path) => seatIdOf(home, path) === seat.id);
  return { adapter, file };
}

export type ExcludeMcpResult = { name: string; status: "removed" | "kept" | "already"; file?: string };

/**
 * Keeps MCP server `name` out of seat `id`: removes it from that seat's file
 * and adds the seat id to its `skip` in `mcp.json`, which sync, merging and
 * `seats install` all respect.
 */
export function excludeMcp(home: string, id: string, name: string): ExcludeMcpResult {
  const seat = findSeatFolder(home, id);
  const { adapter, file } = seatMcp(home, seat);
  const library = readLibrary(home);
  const inSeat = file ? adapter.names(file) : [];
  const live = Object.keys(library).filter((key) => !library[key]!.skip?.includes("*"));
  const key = live.find((key) => lower(key) === lower(name));
  const seatKey = inSeat.find((key) => lower(key) === lower(name));
  if (!key && !seatKey) {
    const names = [...new Set([...live, ...inSeat])].sort();
    throw new Error(`No MCP server named ${name}.${names.length > 0 ? ` Servers: ${names.join(", ")}.` : ""}`);
  }

  const entry = key ? library[key]! : file && seatKey ? adapter.read(file)[seatKey] : undefined;
  // Without a library entry, merging would bring it back from another seat.
  if (!entry) throw new Error(`seats can't read ${seatKey} in ${tilde(file!)}. Remove it there by hand.`);
  const already = entry.skip?.includes(id) ?? false;
  if (!already) {
    library[key ?? seatKey!] = { ...entry, skip: [...(entry.skip ?? []), id] };
    writeJsonAtomic(libraryFile(home), { mcpServers: library });
  }
  const names = inSeat.filter((item) => lower(item) === lower(name));
  if (file && names.length > 0) adapter.remove(file, names);
  return { name: key ?? seatKey!, status: names.length > 0 ? "removed" : already ? "already" : "kept", file };
}

/** Lets seat `id` have MCP server `name` again: the next sync or switch adds it back. */
export function includeMcp(home: string, id: string, name: string): string {
  findSeatFolder(home, id);
  const library = readLibrary(home);
  const key = Object.keys(library).find((item) => lower(item) === lower(name));
  const entry = key ? library[key] : undefined;
  if (!key || !entry?.skip?.includes(id)) throw new Error(`${id} doesn't keep out an MCP server named ${name}.`);
  const skip = entry.skip.filter((item) => item !== id);
  library[key] = { ...entry, skip: skip.length > 0 ? skip : undefined };
  writeJsonAtomic(libraryFile(home), { mcpServers: library });
  return key;
}

/** What seat `id` keeps out: its own copies of shared items, and MCP servers. */
export function listExclusions(home: string, id: string): { items: string[]; mcp: string[] } {
  findSeatFolder(home, id);
  let library = {};
  try {
    library = readLibrary(home);
  } catch {
    // an unreadable mcp.json keeps nothing out
  }
  return { items: readExclusions(home)[id] ?? [], mcp: mcpKeptOut(library, id) };
}

function run<T>(step: () => T): T {
  try {
    return step();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function printList(home: string, id: string): void {
  const { items, mcp } = run(() => listExclusions(home, id));
  if (items.length === 0 && mcp.length === 0) {
    p.outro(`${id} shares everything.`);
    return;
  }
  for (const item of items) p.log.step(`${item}  ${pc.dim("own copy")}`);
  for (const name of mcp) p.log.step(`mcp ${name}  ${pc.dim("kept out")}`);
  p.outro(`Undo with ${pc.cyan(`seats include ${id} <item>`)} or ${pc.cyan(`seats include ${id} mcp <name>`)}.`);
}

/** `seats exclude <seat-id> [<item> | mcp <name>]` */
export async function excludeCommand(args: string[]): Promise<void> {
  const [id, item, name, ...extra] = args;
  if (!id || id === "--help" || id === "-h" || extra.length > 0) return console.log(USAGE);
  if (item !== "mcp" && name) return console.log(USAGE);
  intro();
  const home = homedir();
  if (!item) return printList(home, id);

  if (item === "mcp") {
    if (!name) fail("Name the MCP server, e.g. seats exclude claude:acme mcp gmail");
    const result = run(() => excludeMcp(home, id, name));
    const where = result.file ? pc.dim(`\n${tilde(result.file)}`) : "";
    if (result.status === "already") return p.outro(`${id} already keeps out ${result.name}.`);
    const done = result.status === "removed" ? "Removed" : "Kept out";
    return p.outro(`${done} ${pc.cyan(result.name)} for ${id}. Sync won't add it back.${where}`);
  }

  const result = run(() => excludeItem(home, id, item));
  if (result.status === "already")
    return p.outro(`${id} already keeps its own ${item}.\n${pc.dim(tilde(result.path))}`);
  const note = result.status === "copied" ? "Copied from the shared one. Edit it here:" : "Sync leaves it alone:";
  p.outro(`${id} keeps its own ${item}. ${note}\n${pc.dim(tilde(result.path))}`);
}

/** `seats include <seat-id> <item> | mcp <name>` */
export async function includeCommand(args: string[]): Promise<void> {
  const [id, item, name, ...extra] = args;
  if (!id || !item || id === "--help" || id === "-h" || extra.length > 0) return console.log(USAGE);
  if (item !== "mcp" && name) return console.log(USAGE);
  intro();
  const home = homedir();

  if (item === "mcp") {
    if (!name) fail("Name the MCP server, e.g. seats include claude:acme mcp gmail");
    const key = run(() => includeMcp(home, id, name));
    return p.outro(`${id} gets ${pc.cyan(key)} again on the next seats sync or switch.`);
  }

  const result = run(() => includeItem(home, id, item));
  if (result.backup) p.log.step(`Its own copy is in ${tilde(result.backup)}`);
  p.outro(
    result.linked
      ? `${id} shares ${item} again.`
      : `${id} shares ${item} again. There is no shared copy yet; seats sync makes one.`,
  );
}
