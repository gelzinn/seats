import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { mcpKeptOut, readOwnTrust, type SeatFolder, seatFolders } from "./exclude.ts";
import { isSymlink, lexists, writeJsonAtomic } from "./fs.ts";
import { readLibrary } from "./mcp/library.ts";
import type { McpServers } from "./mcp/types.ts";
import { processesUsing, type RunningProcess, runningProcesses } from "./processes.ts";
import { seatSources } from "./providers/index.ts";
import { parseRecord, shareItems } from "./share.ts";
import { sharedDir } from "./store.ts";
import type { MergeOptions, SeatSource } from "./types.ts";

/**
 * What the CLI's session hook runs, through `sh`. Bare `seats`, so it holds
 * across installs and exports; a no-op where `seats` isn't on the PATH the
 * CLI sees, so a session never shows a failing hook.
 */
export const SESSION_HOOK_COMMAND = "command -v seats >/dev/null 2>&1 && seats hook session || true";

/** The library, or nothing when `mcp.json` doesn't parse: switching seats mustn't fail on it. */
function libraryOrEmpty(home: string): McpServers {
  try {
    return readLibrary(home);
  } catch {
    return {};
  }
}

/** A real path, or the path itself when it doesn't exist. */
const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);

/** The MCP servers and the trust each of `folders` keeps out, from `mcp.json` and `config.json`. */
export function mergeOptions(home: string, folders: SeatFolder[]): MergeOptions {
  const library = libraryOrEmpty(home);
  const own = readOwnTrust(home);
  const idOf = (dir: string) => folders.find((folder) => folder.dir === dir)?.id ?? "";
  return {
    keptOut: (dir) => mcpKeptOut(library, idOf(dir)),
    ownTrust: (dir) => own.includes(idOf(dir)),
  };
}

/** Every folder of `source` and the one `dir` leads to, when `source` merges seats and has two or more. */
function seatsOf(home: string, source: SeatSource, dir: string) {
  if (!source.mergeSeats) return undefined;
  const folders = seatFolders(home, source);
  const current = folders.find((folder) => real(folder.dir) === real(dir));
  return current && folders.length > 1 ? { folders, current, merge: source.mergeSeats } : undefined;
}

/**
 * Before a launch: brings the trust and approvals the other seats gave into
 * the seat in `dir`, so its CLI starts without asking again. Never throws.
 */
export function pullTrust(home: string, source: SeatSource, dir: string): string[] {
  try {
    const found = seatsOf(home, source, dir);
    if (!found) return [];
    const { folders, current, merge } = found;
    return merge(
      folders.map((folder) => folder.dir),
      { ...mergeOptions(home, folders), targets: [current.dir] },
    );
  } catch {
    return [];
  }
}

/**
 * From a running session in `dir`: carries trust to the other seats of
 * `source`. That seat's own file is never written (its CLI rewrites it), and
 * neither is a seat that keeps its own trust or has its CLI open right now;
 * the open ones pull it at their next launch.
 */
export function pushTrust(
  home: string,
  source: SeatSource,
  dir: string,
  list: () => RunningProcess[] = runningProcesses,
): string[] {
  const found = seatsOf(home, source, dir);
  if (!found) return [];
  const { folders, current, merge } = found;
  const options = mergeOptions(home, folders);
  if (options.ownTrust!(current.dir)) return [];
  let processes: RunningProcess[] | undefined;
  const running = () => (processes ??= list());
  const busy = (folder: SeatFolder) =>
    source.binary !== undefined &&
    source.configDirEnv !== undefined &&
    processesUsing(source.binary, source.configDirEnv, folder.dir, running, source.livePath?.(home)).length > 0;
  const targets = folders.filter((folder) => folder !== current && !options.ownTrust!(folder.dir) && !busy(folder));
  if (targets.length === 0) return [];
  return merge(
    folders.map((folder) => folder.dir),
    { ...options, targets: targets.map((folder) => folder.dir) },
  );
}

/**
 * `seats hook session`: pushes trust from the seat the CLI runs on, named by
 * its config dir env var or else its live path. Not a seat: nothing happens.
 */
export function pushFromSession(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return seatSources
    .filter((source) => source.sessionHook && source.configDirEnv && source.livePath)
    .flatMap((source) => pushTrust(home, source, env[source.configDirEnv!] || source.livePath!(home)));
}

/**
 * Puts the session hook in the settings file the seats of `source` share:
 * the file their links lead to, else a new shared one linked into each.
 * Returns the file, or undefined when the hook is there already, every seat
 * keeps its own copy, or the file doesn't parse.
 */
export function addSessionHook(
  home: string,
  source: SeatSource,
  dirs: string[],
  keep: (dir: string, item: string) => boolean,
  { dryRun = false } = {},
): string | undefined {
  const hook = source.sessionHook;
  if (!hook) return undefined;
  const sharing = dirs.filter((dir) => !keep(dir, hook.item));
  if (sharing.length === 0) return undefined;
  const linked = sharing.map((dir) => join(dir, hook.item)).find((path) => isSymlink(path) && existsSync(path));
  const shared = join(sharedDir(home, source.id), hook.item);
  const file = linked ?? shared;

  const created = !lexists(file);
  const settings = created ? {} : readSettings(file);
  if (!settings) return undefined;
  const next = hook.add(settings, SESSION_HOOK_COMMAND);
  if (!next) return undefined;
  if (!dryRun) {
    writeJsonAtomic(file, next);
    if (created) shareItems(dirs, sharedDir(home, source.id), [hook.item], keep);
  }
  return existsSync(file) ? realpathSync(file) : file;
}

function readSettings(file: string): Record<string, unknown> | undefined {
  try {
    return parseRecord(readFileSync(file));
  } catch {
    return undefined;
  }
}
